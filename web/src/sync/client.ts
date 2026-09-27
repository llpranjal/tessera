// The client half of the sync protocol.
//
// Local edits apply immediately (optimistic), are batched once per frame, and
// sent with a sequence number. The client keeps two views of the document:
//
//   confirmed  what the server has applied, in the server's order
//   nodes      confirmed + our unacknowledged ops replayed on top (what we draw)
//
// Because each connection is FIFO, any remote op we receive before the ack for
// one of our batches was ordered *before* that batch on the server. So when a
// remote op arrives we apply it to `confirmed` and re-derive `nodes` for just
// the touched ids by replaying our pending ops. When an ack arrives, the batch
// moves from pending into `confirmed` and the drawn state doesn't change.
// Every client therefore converges on exactly the server's state.

import type { ClientMsg, Cursor, Json, Op, PeerInfo, Props, ServerMsg } from './protocol'

export type Status = 'connecting' | 'online' | 'offline' | 'deleted'

export interface Transport {
  send(data: string): void
  close(): void
}

export interface TransportHandlers {
  onOpen(): void
  onMessage(data: string): void
  onClose(): void
}

export type TransportFactory = (handlers: TransportHandlers) => Transport

interface Batch {
  ops: Op[]
  seq?: number
}

export interface SyncSnapshot {
  nodes: ReadonlyMap<string, Props>
  peers: ReadonlyMap<number, PeerInfo>
  me: PeerInfo | null
  status: Status
  docName: string
  version: number
  pendingBatches: number
}

/** Apply ops to a node map with the same semantics as the server. */
export function applyOps(nodes: Map<string, Props>, ops: Op[]) {
  for (const op of ops) {
    if (op.k === 'create') {
      const props: Props = {}
      for (const [k, v] of Object.entries(op.props)) if (v !== null) props[k] = v
      nodes.set(op.id, props)
    } else if (op.k === 'del') {
      nodes.delete(op.id)
    } else {
      const node = nodes.get(op.id)
      if (!node) continue
      let next: Props | null = null
      for (const [k, v] of Object.entries(op.props)) {
        next ??= { ...node }
        if (v === null) delete next[k]
        else next[k] = v
      }
      if (next) nodes.set(op.id, next)
    }
  }
}

/** Merge a queue of ops into as few ops as possible, preserving meaning. */
export function coalesce(ops: Op[]): Op[] {
  const out: (Op | null)[] = []
  const last = new Map<string, number>()
  for (const op of ops) {
    const at = last.get(op.id)
    if (op.k === 'set' && at !== undefined) {
      const prev = out[at]!
      if (prev.k === 'create') {
        const props = { ...prev.props }
        for (const [k, v] of Object.entries(op.props)) {
          if (v === null) delete props[k]
          else props[k] = v
        }
        out[at] = { ...prev, props }
        continue
      }
      if (prev.k === 'set') {
        out[at] = { ...prev, props: { ...prev.props, ...op.props } }
        continue
      }
    }
    if (op.k === 'del' && at !== undefined) out[at] = null
    last.set(op.id, out.length)
    out.push(op)
    if (op.k === 'del') last.delete(op.id)
  }
  return out.filter((o): o is Op => o !== null)
}

export class SyncClient {
  private nodes = new Map<string, Props>()
  private confirmed = new Map<string, Props>()
  private peers = new Map<number, PeerInfo>()
  private me: PeerInfo | null = null
  private status: Status = 'connecting'
  private docName = ''
  private version = 0

  private queued: Batch = { ops: [] }
  private inflight: Batch[] = []
  private seq = 0

  private transport: Transport | null = null
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private flushScheduled = false
  private disposed = false

  private presence: { cursor: Cursor; selection: string[] } = { cursor: null, selection: [] }
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private presenceDirty = false

  private listeners = new Set<() => void>()
  private snapshot: SyncSnapshot | null = null
  private emitScheduled = false

  /** Called for every op batch that came from another peer. */
  onRemoteOps?: (ops: Op[], from: number) => void
  /** Called when the server refuses one of our batches. */
  onReject?: (message: string) => void

  private readonly factory: TransportFactory
  private readonly schedule: (fn: () => void) => void

  constructor(factory: TransportFactory, schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 16)) {
    this.factory = factory
    this.schedule = schedule
    this.connect()
  }

  // ---- public API ----------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): SyncSnapshot => {
    this.snapshot ??= {
      nodes: new Map(this.nodes),
      peers: new Map(this.peers),
      me: this.me,
      status: this.status,
      docName: this.docName,
      version: this.version,
      pendingBatches: this.inflight.length + (this.queued.ops.length ? 1 : 0),
    }
    return this.snapshot
  }

  get(id: string): Props | undefined {
    return this.nodes.get(id)
  }

  /** Apply local edits optimistically and queue them for the server. */
  apply(ops: Op[]) {
    if (!ops.length || this.status === 'deleted') return
    applyOps(this.nodes, ops)
    this.queued.ops.push(...ops)
    this.scheduleFlush()
    this.changed()
  }

  /** Update our cursor and/or selection; omitted fields keep their last value. */
  setPresence(update: { cursor?: Cursor; selection?: string[] }) {
    this.presence = { ...this.presence, ...update }
    this.presenceDirty = true
    if (this.presenceTimer) return
    this.sendPresence()
    // Throttle to ~25 updates per second.
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      if (this.presenceDirty) this.sendPresence()
    }, 40)
  }

  /** Send queued ops now instead of waiting for the next frame. */
  flush() {
    this.flushScheduled = false
    if (!this.queued.ops.length) return
    const batch: Batch = { ops: coalesce(this.queued.ops) }
    this.queued = { ops: [] }
    this.inflight.push(batch)
    if (this.status === 'online') this.sendBatch(batch)
  }

  dispose() {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    this.flush()
    this.transport?.close()
    this.listeners.clear()
  }

  // ---- connection ----------------------------------------------------------

  private connect() {
    this.setStatus(this.retries === 0 ? 'connecting' : 'offline')
    const transport = this.factory({
      onOpen: () => {},
      onMessage: (data) => {
        if (this.transport === transport) this.receive(JSON.parse(data) as ServerMsg)
      },
      onClose: () => {
        if (this.transport !== transport) return
        this.transport = null
        if (this.disposed || this.status === 'deleted') return
        this.setStatus('offline')
        this.peers.clear()
        this.changed()
        const delay = Math.min(8000, 400 * 2 ** this.retries) * (0.75 + Math.random() * 0.5)
        this.retries++
        this.retryTimer = setTimeout(() => this.connect(), delay)
      },
    })
    this.transport = transport
  }

  private send(msg: ClientMsg) {
    this.transport?.send(JSON.stringify(msg))
  }

  private sendBatch(batch: Batch) {
    batch.seq = ++this.seq
    this.send({ t: 'ops', seq: batch.seq, ops: batch.ops })
  }

  private sendPresence() {
    this.presenceDirty = false
    if (this.status === 'online') this.send({ t: 'presence', ...this.presence })
  }

  private scheduleFlush() {
    if (this.flushScheduled) return
    this.flushScheduled = true
    this.schedule(() => this.flush())
  }

  // ---- incoming ------------------------------------------------------------

  private receive(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome': {
        this.retries = 0
        this.me = msg.you
        this.docName = msg.doc.name
        this.peers = new Map(msg.peers.map((p) => [p.sid, p]))
        this.status = 'online'
        this.rebase(msg.version, msg.nodes)
        // Anything unacknowledged may not have reached the server: send it again.
        // Replays are safe because create/set/del are idempotent.
        for (const batch of this.inflight) this.sendBatch(batch)
        this.sendPresence()
        break
      }
      case 'snapshot':
        this.rebase(msg.version, msg.nodes)
        break
      case 'ack': {
        const batch = this.inflight.shift()
        if (!batch || batch.seq !== msg.seq) {
          console.warn('ack out of order', msg.seq, batch?.seq)
        }
        if (batch) applyOps(this.confirmed, batch.ops)
        this.version = msg.version
        break
      }
      case 'reject': {
        const i = this.inflight.findIndex((b) => b.seq === msg.seq)
        if (i >= 0) this.inflight.splice(i, 1)
        this.onReject?.(msg.message)
        break // a snapshot follows
      }
      case 'ops': {
        this.version = msg.version
        applyOps(this.confirmed, msg.ops)
        this.rederive(new Set(msg.ops.map((o) => o.id)))
        this.onRemoteOps?.(msg.ops, msg.from)
        break
      }
      case 'presence': {
        const peer = this.peers.get(msg.sid)
        if (peer) this.peers.set(msg.sid, { ...peer, cursor: msg.cursor, selection: msg.selection })
        break
      }
      case 'join':
        this.peers.set(msg.peer.sid, msg.peer)
        break
      case 'leave':
        this.peers.delete(msg.sid)
        break
      case 'meta':
        this.docName = msg.name
        break
      case 'deleted':
        this.status = 'deleted'
        this.transport?.close()
        break
    }
    this.changed()
  }

  /** Reset to the server's state, then re-apply our own unacknowledged edits on top. */
  private rebase(version: number, nodes: Record<string, Props>) {
    this.version = version
    this.confirmed = new Map(Object.entries(nodes))
    this.nodes = new Map(this.confirmed)
    for (const batch of this.inflight) applyOps(this.nodes, batch.ops)
    applyOps(this.nodes, this.queued.ops)
  }

  /** Recompute the drawn state of `ids` as confirmed state + our pending ops. */
  private rederive(ids: Set<string>) {
    const scratch = new Map<string, Props>()
    for (const id of ids) {
      const base = this.confirmed.get(id)
      if (base) scratch.set(id, base)
    }
    const replay = (ops: Op[]) => applyOps(scratch, ops.filter((o) => ids.has(o.id)))
    for (const batch of this.inflight) replay(batch.ops)
    replay(this.queued.ops)
    for (const id of ids) {
      const node = scratch.get(id)
      if (node) this.nodes.set(id, node)
      else this.nodes.delete(id)
    }
  }

  // ---- change notification -------------------------------------------------

  private setStatus(s: Status) {
    if (this.status === s) return
    this.status = s
    this.changed()
  }

  private changed() {
    this.snapshot = null
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      for (const fn of this.listeners) fn()
    })
  }
}

/** Real WebSocket transport. */
export function webSocketTransport(docId: string, name: string): TransportFactory {
  return (h) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(docId)}?name=${encodeURIComponent(name)}`)
    ws.onopen = () => h.onOpen()
    ws.onmessage = (e) => h.onMessage(e.data as string)
    ws.onclose = () => h.onClose()
    return { send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d), close: () => ws.close() }
  }
}

export type { Json }
