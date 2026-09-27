// Local undo/redo. Each entry stores the *inverse* ops of something this user
// did, so undo only ever rewrites properties we touched: a teammate's edits to
// other properties or other nodes are left alone.

import type { Json, Op, Props } from '../sync/protocol'
import { applyOps } from '../sync/client'

export interface OpSink {
  get(id: string): Props | undefined
  apply(ops: Op[]): void
}

/** Ops that undo `ops` when applied after them, given the state before. */
export function invert(ops: Op[], get: (id: string) => Props | undefined): Op[] {
  // State of each touched node as the batch progresses (null = deleted).
  const scratch = new Map<string, Props | null>()
  const current = (id: string) => (scratch.has(id) ? (scratch.get(id) ?? undefined) : get(id))
  const inverse: Op[] = []
  for (const op of ops) {
    const before = current(op.id)
    if (op.k === 'create') {
      inverse.push(before ? { k: 'create', id: op.id, props: before } : { k: 'del', id: op.id })
    } else if (op.k === 'del') {
      if (before) inverse.push({ k: 'create', id: op.id, props: before })
    } else if (before) {
      const props: Props = {}
      for (const k of Object.keys(op.props)) props[k] = before[k] ?? null
      inverse.push({ k: 'set', id: op.id, props })
    }
    // Track state through the batch so repeated edits to one node invert correctly.
    const m = new Map<string, Props>()
    if (before) m.set(op.id, before)
    applyOps(m, [op])
    scratch.set(op.id, m.get(op.id) ?? null)
  }
  return inverse.reverse()
}

export type Snapshot = Map<string, Props | undefined>

export class History {
  private undoStack: Op[][] = []
  private redoStack: Op[][] = []
  private listeners = new Set<() => void>()

  private sink: OpSink
  private limit: number

  constructor(sink: OpSink, limit = 200) {
    this.sink = sink
    this.limit = limit
  }

  /** Apply `ops` as one undoable step. */
  commit(ops: Op[]) {
    if (!ops.length) return
    const inv = invert(ops, (id) => this.sink.get(id))
    this.sink.apply(ops)
    this.push(inv)
  }

  /** Capture nodes before a continuous gesture (drag, resize, scrub). */
  snapshot(ids: Iterable<string>): Snapshot {
    const snap: Snapshot = new Map()
    for (const id of ids) snap.set(id, this.sink.get(id))
    return snap
  }

  /** Record one undo step that restores `snap`. */
  commitGesture(snap: Snapshot) {
    const inverse: Op[] = []
    for (const [id, before] of snap) {
      const now = this.sink.get(id)
      if (!before) {
        if (now) inverse.push({ k: 'del', id })
      } else if (!now) {
        inverse.push({ k: 'create', id, props: before })
      } else {
        const props: Props = {}
        let changed = false
        for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
          if (!same(before[k], now[k])) {
            props[k] = before[k] ?? null
            changed = true
          }
        }
        if (changed) inverse.push({ k: 'set', id, props })
      }
    }
    this.push(inverse)
  }

  undo() {
    this.step(this.undoStack, this.redoStack)
  }

  redo() {
    this.step(this.redoStack, this.undoStack)
  }

  get canUndo() {
    return this.undoStack.length > 0
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private step(from: Op[][], to: Op[][]) {
    const ops = from.pop()
    if (!ops) return
    to.push(invert(ops, (id) => this.sink.get(id)))
    this.sink.apply(ops)
    this.emit()
  }

  private push(inverse: Op[]) {
    if (!inverse.length) return
    this.undoStack.push(inverse)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.emit()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
