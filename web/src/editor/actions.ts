import type { Op, Props } from '../sync/protocol'
import { keyBetween, keysBetween } from '../sync/fractional'
import { newId, round, type NodeView } from './model'

export type Arrange = 'front' | 'back' | 'forward' | 'backward'

export const topIndex = (views: NodeView[]) => views[views.length - 1]?.index || null

/** New z-order keys for the selected nodes, keeping their relative order. */
export function arrange(views: NodeView[], selection: string[], dir: Arrange): Op[] {
  const sel = new Set(selection)
  const chosen = views.filter((v) => sel.has(v.id))
  if (!chosen.length) return []
  let lo: string | null = null
  let hi: string | null = null
  if (dir === 'front') {
    lo = topIndex(views)
  } else if (dir === 'back') {
    hi = views[0].index || null
  } else if (dir === 'forward') {
    const last = views.findLastIndex((v) => sel.has(v.id))
    const q = views.findIndex((v, i) => i > last && !sel.has(v.id))
    if (q < 0) return []
    lo = views[q].index
    hi = views[q + 1]?.index ?? null
  } else {
    const first = views.findIndex((v) => sel.has(v.id))
    const q = views.findLastIndex((v, i) => i < first && !sel.has(v.id))
    if (q < 0) return []
    hi = views[q].index
    lo = views[q - 1]?.index ?? null
  }
  // Concurrent inserts can leave equal keys; widen the range rather than fail.
  if (lo !== null && hi !== null && lo >= hi) {
    if (dir === 'backward') lo = null
    else hi = null
  }
  const keys = keysBetween(lo, hi, chosen.length)
  return chosen.map((v, i) => ({ k: 'set', id: v.id, props: { index: keys[i] } }))
}

export function remove(selection: string[]): Op[] {
  return selection.map((id) => ({ k: 'del', id }))
}

export function nudge(views: NodeView[], selection: string[], dx: number, dy: number): Op[] {
  const sel = new Set(selection)
  return views.filter((v) => sel.has(v.id)).map((v) => ({ k: 'set', id: v.id, props: { x: round(v.x + dx), y: round(v.y + dy) } }))
}

/** Copies of `props` placed above everything else, offset by (dx, dy). */
export function placeCopies(views: NodeView[], props: Props[], dx: number, dy: number): { ops: Op[]; ids: string[] } {
  const keys = keysBetween(topIndex(views), null, props.length)
  const ids: string[] = []
  const ops: Op[] = props.map((p, i) => {
    const id = newId()
    ids.push(id)
    const x = typeof p.x === 'number' ? p.x + dx : dx
    const y = typeof p.y === 'number' ? p.y + dy : dy
    return { k: 'create', id, props: { ...p, x, y, index: keys[i] } }
  })
  return { ops, ids }
}

export function selectedProps(views: NodeView[], selection: string[], get: (id: string) => Props | undefined): Props[] {
  const sel = new Set(selection)
  return views.filter((v) => sel.has(v.id)).flatMap((v) => (get(v.id) ? [get(v.id)!] : []))
}

const CLIP_TYPE = 'tessera/nodes'

export function toClipboard(props: Props[]): string {
  return JSON.stringify({ type: CLIP_TYPE, nodes: props })
}

export function fromClipboard(text: string): Props[] | null {
  try {
    const data = JSON.parse(text)
    if (data?.type !== CLIP_TYPE || !Array.isArray(data.nodes)) return null
    return data.nodes.filter((n: unknown) => n && typeof n === 'object' && !Array.isArray(n))
  } catch {
    return null
  }
}

export function newIndex(views: NodeView[]): string {
  return keyBetween(topIndex(views), null)
}
