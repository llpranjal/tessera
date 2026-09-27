import { describe, expect, it } from 'vitest'
import { applyOps, coalesce, SyncClient, type TransportHandlers } from './client'
import type { Op, Props, ServerMsg } from './protocol'

// An in-memory stand-in for the Rust room. Each connection has two FIFO
// queues (to and from the server) and the test decides when messages move,
// so we can reproduce any interleaving the network could produce.

interface Conn {
  sid: number
  handlers: TransportHandlers
  up: string[]
  down: string[]
  open: boolean
}

class FakeServer {
  nodes = new Map<string, Props>()
  version = 0
  conns: Conn[] = []
  nextSid = 1

  factory = (handlers: TransportHandlers) => {
    const conn: Conn = { sid: this.nextSid++, handlers, up: [], down: [], open: true }
    this.conns.push(conn)
    this.push(conn, {
      t: 'welcome',
      you: { sid: conn.sid, name: `p${conn.sid}`, color: '#000', cursor: null, selection: [] },
      doc: { id: 'd', name: 'Doc' },
      version: this.version,
      nodes: Object.fromEntries(this.nodes),
      peers: [],
    })
    return {
      // Presence isn't part of the document protocol under test.
      send: (d: string) => conn.open && JSON.parse(d).t === 'ops' && conn.up.push(d),
      close: () => this.drop(conn),
    }
  }

  push(conn: Conn, msg: ServerMsg) {
    conn.down.push(JSON.stringify(msg))
  }

  drop(conn: Conn) {
    if (!conn.open) return
    conn.open = false
    conn.up = []
    conn.down = []
    conn.handlers.onClose()
  }

  /** Server processes one message from this connection. */
  processUp(conn: Conn) {
    const raw = conn.up.shift()
    if (!raw) return
    const msg = JSON.parse(raw)
    if (msg.t !== 'ops') return
    const bad = (msg.ops as Op[]).some((o) => o.id === '')
    if (bad) {
      this.push(conn, { t: 'reject', seq: msg.seq, message: 'bad' })
      this.push(conn, { t: 'snapshot', version: this.version, nodes: Object.fromEntries(this.nodes) })
      return
    }
    applyOps(this.nodes, msg.ops)
    this.version++
    this.push(conn, { t: 'ack', seq: msg.seq, version: this.version })
    for (const other of this.conns) {
      if (other !== conn && other.open) this.push(other, { t: 'ops', from: conn.sid, version: this.version, ops: msg.ops })
    }
  }

  /** Client receives one message. */
  deliverDown(conn: Conn) {
    const raw = conn.down.shift()
    if (raw) conn.handlers.onMessage(raw)
  }

  settle() {
    for (let guard = 0; guard < 10_000; guard++) {
      const busy = this.conns.find((c) => c.open && (c.up.length || c.down.length))
      if (!busy) return
      if (busy.down.length) this.deliverDown(busy)
      else this.processUp(busy)
    }
    throw new Error('did not settle')
  }
}

function makeClient(server: FakeServer) {
  const flushes: (() => void)[] = []
  const client = new SyncClient(server.factory, (fn) => flushes.push(fn))
  const conn = server.conns[server.conns.length - 1]
  server.deliverDown(conn) // welcome
  const flush = () => flushes.splice(0).forEach((f) => f())
  return { client, conn, flush }
}

const nodesOf = (c: SyncClient) => Object.fromEntries(c.getSnapshot().nodes)

describe('coalesce', () => {
  it('folds sets into the create and into earlier sets', () => {
    const ops: Op[] = [
      { k: 'create', id: 'a', props: { x: 0, y: 0 } },
      { k: 'set', id: 'b', props: { x: 1 } },
      { k: 'set', id: 'a', props: { x: 5, y: null } },
      { k: 'set', id: 'b', props: { y: 2 } },
    ]
    expect(coalesce(ops)).toEqual([
      { k: 'create', id: 'a', props: { x: 5 } },
      { k: 'set', id: 'b', props: { x: 1, y: 2 } },
    ])
  })

  it('drops edits that a later delete makes irrelevant', () => {
    const ops: Op[] = [
      { k: 'set', id: 'a', props: { x: 1 } },
      { k: 'del', id: 'a' },
      { k: 'create', id: 'a', props: { x: 2 } },
    ]
    expect(coalesce(ops)).toEqual([
      { k: 'del', id: 'a' },
      { k: 'create', id: 'a', props: { x: 2 } },
    ])
  })
})

describe('SyncClient', () => {
  it('applies local edits optimistically and batches them per frame', () => {
    const s = new FakeServer()
    const { client, conn, flush } = makeClient(s)
    client.apply([{ k: 'create', id: 'n', props: { x: 1 } }])
    client.apply([{ k: 'set', id: 'n', props: { x: 2 } }])
    expect(nodesOf(client)).toEqual({ n: { x: 2 } })
    expect(conn.up).toHaveLength(0)
    flush()
    expect(conn.up).toHaveLength(1)
    expect(JSON.parse(conn.up[0]).ops).toEqual([{ k: 'create', id: 'n', props: { x: 2 } }])
  })

  it('ignores remote writes to keys with unacknowledged local writes', () => {
    const s = new FakeServer()
    s.nodes.set('n', { x: 0, y: 0 })
    const a = makeClient(s)
    const b = makeClient(s)

    // B writes x first and it reaches the server first.
    b.client.apply([{ k: 'set', id: 'n', props: { x: 'b' } }])
    b.flush()
    s.processUp(b.conn)
    // A writes x and y before hearing about B's write.
    a.client.apply([{ k: 'set', id: 'n', props: { x: 'a' } }])
    a.flush()
    // A now receives B's write while its own is still pending: x must not flicker back.
    s.deliverDown(a.conn)
    expect(a.client.get('n')!.x).toBe('a')

    s.settle()
    expect(nodesOf(a.client)).toEqual(Object.fromEntries(s.nodes))
    expect(nodesOf(b.client)).toEqual(Object.fromEntries(s.nodes))
    expect(s.nodes.get('n')!.x).toBe('a')
  })

  it('lets a remote delete win over a pending local edit', () => {
    const s = new FakeServer()
    s.nodes.set('n', { x: 0 })
    const a = makeClient(s)
    const b = makeClient(s)
    b.client.apply([{ k: 'del', id: 'n' }])
    b.flush()
    s.processUp(b.conn)
    a.client.apply([{ k: 'set', id: 'n', props: { x: 9 } }])
    a.flush()
    s.settle()
    expect(s.nodes.has('n')).toBe(false)
    expect(nodesOf(a.client)).toEqual({})
  })

  it('rebases on a snapshot after a rejected batch', () => {
    const s = new FakeServer()
    const a = makeClient(s)
    const rejects: string[] = []
    a.client.onReject = (m) => rejects.push(m)
    a.client.apply([{ k: 'create', id: '', props: { x: 1 } }])
    a.flush()
    a.client.apply([{ k: 'create', id: 'ok', props: { x: 2 } }])
    a.flush()
    s.processUp(a.conn) // rejects batch 1
    s.deliverDown(a.conn) // reject
    s.deliverDown(a.conn) // snapshot: batch 2 still in flight, must survive the rebase
    expect(nodesOf(a.client)).toEqual({ ok: { x: 2 } })
    s.settle()
    expect(rejects).toEqual(['bad'])
    expect(nodesOf(a.client)).toEqual({ ok: { x: 2 } })
    expect(a.client.getSnapshot().pendingBatches).toBe(0)
  })

  it('replays unacknowledged edits after reconnecting', async () => {
    const s = new FakeServer()
    s.nodes.set('n', { x: 0 })
    const a = makeClient(s)
    a.client.apply([{ k: 'set', id: 'n', props: { x: 42 } }])
    a.flush()
    s.drop(a.conn) // connection dies before the server reads the batch
    expect(a.client.getSnapshot().status).toBe('offline')
    // Edits keep working offline.
    a.client.apply([{ k: 'set', id: 'n', props: { y: 7 } }])
    a.flush()
    expect(nodesOf(a.client)).toEqual({ n: { x: 42, y: 7 } })

    await new Promise((r) => setTimeout(r, 700)) // reconnect backoff
    const conn = s.conns[s.conns.length - 1]
    expect(conn).not.toBe(a.conn)
    s.settle()
    expect(Object.fromEntries(s.nodes)).toEqual({ n: { x: 42, y: 7 } })
    expect(a.client.getSnapshot().status).toBe('online')
    expect(a.client.getSnapshot().pendingBatches).toBe(0)
    a.client.dispose()
  })

  it('keeps the last cursor when only the selection changes', () => {
    const sent: string[] = []
    let handlers!: TransportHandlers
    const client = new SyncClient((h) => {
      handlers = h
      return { send: (d) => sent.push(d), close: () => {} }
    })
    handlers.onMessage(JSON.stringify({
      t: 'welcome', you: { sid: 1, name: 'a', color: '#000', cursor: null, selection: [] },
      doc: { id: 'd', name: 'D' }, version: 0, nodes: {}, peers: [],
    }))
    client.setPresence({ cursor: [5, 6] })
    client.setPresence({ selection: ['n'] })
    return new Promise<void>((done) => setTimeout(() => {
      const last = JSON.parse(sent[sent.length - 1])
      expect(last).toEqual({ t: 'presence', cursor: [5, 6], selection: ['n'] })
      client.dispose()
      done()
    }, 60))
  })

  it('converges under randomized concurrent edits and delivery orders', () => {
    for (let trial = 0; trial < 60; trial++) {
      let seed = trial + 1
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]

      const s = new FakeServer()
      for (const id of ['a', 'b', 'c']) s.nodes.set(id, { x: 0, fill: 'red' })
      const clients = [makeClient(s), makeClient(s), makeClient(s)]

      for (let step = 0; step < 300; step++) {
        const c = pick(clients)
        const r = rand()
        if (r < 0.35) {
          const id = pick(['a', 'b', 'c', 'd', 'e'])
          const roll = rand()
          const op: Op =
            roll < 0.7
              ? { k: 'set', id, props: { [pick(['x', 'fill', 'w'])]: Math.floor(rand() * 100) } }
              : roll < 0.85
                ? { k: 'create', id, props: { x: step } }
                : { k: 'del', id }
          c.client.apply([op])
        } else if (r < 0.5) {
          c.flush()
        } else if (r < 0.75) {
          s.processUp(c.conn)
        } else {
          s.deliverDown(c.conn)
        }
      }
      clients.forEach((c) => c.flush())
      s.settle()
      const truth = Object.fromEntries(s.nodes)
      for (const c of clients) expect(nodesOf(c.client), `trial ${trial}`).toEqual(truth)
    }
  })
})
