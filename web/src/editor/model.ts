import type { Json, Props } from '../sync/protocol'
import { compareOrder } from '../sync/fractional'

export type NodeType = 'rect' | 'ellipse' | 'text' | 'path'
export type Tool = 'select' | 'hand' | NodeType

export interface NodeView {
  id: string
  type: NodeType
  name: string
  index: string
  x: number
  y: number
  w: number
  h: number
  fill: string
  stroke: string | null
  strokeWidth: number
  radius: number
  opacity: number
  text: string
  fontSize: number
  fontWeight: number
  points: [number, number][]
}

export const TYPE_LABEL: Record<NodeType, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  path: 'Drawing',
}

export const SWATCHES = ['#161A23', '#5B6272', '#D8DCE5', '#FFFFFF', '#2B3BEA', '#0FA3D1', '#12A383', '#F2A516', '#E8457A', '#8A4DEB']

const num = (v: Json | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: Json | undefined, d: string) => (typeof v === 'string' ? v : d)

function points(v: Json | undefined): [number, number][] {
  if (!Array.isArray(v)) return []
  const out: [number, number][] = []
  for (const p of v) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') out.push([p[0], p[1]])
  }
  return out
}

export function toView(id: string, p: Props): NodeView {
  const type = (['rect', 'ellipse', 'text', 'path'] as const).find((t) => t === p.type) ?? 'rect'
  return {
    id,
    type,
    name: str(p.name, ''),
    index: str(p.index, ''),
    x: num(p.x, 0),
    y: num(p.y, 0),
    w: Math.max(1, num(p.w, 100)),
    h: Math.max(1, num(p.h, 100)),
    fill: str(p.fill, type === 'text' ? '#161A23' : '#D8DCE5'),
    stroke: typeof p.stroke === 'string' ? p.stroke : type === 'path' ? '#161A23' : null,
    strokeWidth: num(p.strokeWidth, type === 'path' ? 4 : 0),
    radius: num(p.radius, 0),
    opacity: Math.min(1, Math.max(0, num(p.opacity, 1))),
    text: str(p.text, ''),
    fontSize: num(p.fontSize, 20),
    fontWeight: num(p.fontWeight, 500),
    points: points(p.points),
  }
}

export function displayName(n: NodeView): string {
  return n.name || (n.type === 'text' && n.text ? n.text.slice(0, 40) : TYPE_LABEL[n.type])
}

/** All nodes, bottom to top. */
export function sortedViews(nodes: ReadonlyMap<string, Props>): NodeView[] {
  return [...nodes].map(([id, p]) => toView(id, p)).sort(compareOrder)
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

export const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places
