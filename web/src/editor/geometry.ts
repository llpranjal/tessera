export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Camera {
  x: number
  y: number
  z: number
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function boxFromPoints(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

export function handlePoint(b: Box, h: Handle): [number, number] {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2
  return [x, y]
}

/**
 * Drag `handle` of `start` by (dx, dy). Dragging past the opposite edge flips
 * the box. With `keepAspect`, corner handles preserve the original ratio.
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, keepAspect = false): Box {
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h
  if (handle.includes('w')) x0 += dx
  if (handle.includes('e')) x1 += dx
  if (handle.includes('n')) y0 += dy
  if (handle.includes('s')) y1 += dy
  let box = boxFromPoints(x0, y0, x1, y1)
  if (keepAspect && handle.length === 2 && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h
    const scale = Math.max(box.w / start.w, box.h / start.h)
    const w = start.h * ratio * scale
    const h = start.h * scale
    // Anchor at the corner opposite the handle.
    const ax = handle.includes('w') ? start.x + start.w : start.x
    const ay = handle.includes('n') ? start.y + start.h : start.y
    const flipX = handle.includes('w') ? x0 > ax : x1 < ax
    const flipY = handle.includes('n') ? y0 > ay : y1 < ay
    const towardLeft = handle.includes('w') !== flipX
    const towardUp = handle.includes('n') !== flipY
    box = { x: towardLeft ? ax - w : ax, y: towardUp ? ay - h : ay, w, h }
  }
  return box
}

/** Map `b` from the `from` frame into the `to` frame (used for multi-select resize). */
export function mapBox(b: Box, from: Box, to: Box): Box {
  const sx = from.w ? to.w / from.w : 1
  const sy = from.h ? to.h / from.h : 1
  return { x: to.x + (b.x - from.x) * sx, y: to.y + (b.y - from.y) * sy, w: b.w * sx, h: b.h * sy }
}

export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.x) / cam.z, (sy - cam.y) / cam.z]
}

export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [wx * cam.z + cam.x, wy * cam.z + cam.y]
}

/** Zoom by `factor` keeping the screen point (sx, sy) fixed. */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.z * factor))
  const [wx, wy] = screenToWorld(cam, sx, sy)
  return { x: sx - wx * z, y: sy - wy * z, z }
}

/** Camera that fits `box` inside a viewport of the given size. */
export function fitCamera(box: Box, vw: number, vh: number, padding = 80, maxZoom = 1): Camera {
  const z = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((vw - padding * 2) / box.w, (vh - padding * 2) / box.h)))
  return { x: vw / 2 - (box.x + box.w / 2) * z, y: vh / 2 - (box.y + box.h / 2) * z, z }
}

/** Drop points closer than `minDist` to the previous kept point. */
export function simplify(points: [number, number][], minDist: number): [number, number][] {
  if (points.length <= 2) return points
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1]
    if (Math.hypot(points[i][0] - px, points[i][1] - py) >= minDist) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

/** Smooth SVG path through points using quadratic curves between midpoints. */
export function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return ''
  if (pts.length < 3) return `M${pts[0][0]} ${pts[0][1]}` + pts.slice(1).map((p) => ` L${p[0]} ${p[1]}`).join('')
  let d = `M${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2
    const my = (pts[i][1] + pts[i + 1][1]) / 2
    d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`
  }
  const last = pts[pts.length - 1]
  return d + ` L${last[0]} ${last[1]}`
}
