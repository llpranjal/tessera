import { describe, expect, it } from 'vitest'
import { applyOps } from '../sync/client'
import type { Op, Props } from '../sync/protocol'
import { fitCamera, mapBox, resizeBox, screenToWorld, simplify, worldToScreen, zoomAt } from './geometry'
import { History, invert } from './history'
import { toView } from './model'

class MemSink {
  nodes = new Map<string, Props>()
  get = (id: string) => this.nodes.get(id)
  apply = (ops: Op[]) => applyOps(this.nodes, ops)
}

describe('invert', () => {
  it('undoes creates, sets, and deletes within one batch', () => {
    const sink = new MemSink()
    sink.nodes.set('a', { x: 1, fill: 'red' })
    const before = structuredClone(Object.fromEntries(sink.nodes))
    const ops: Op[] = [
      { k: 'set', id: 'a', props: { x: 2, stroke: 'blue' } },
      { k: 'set', id: 'a', props: { x: 3 } },
      { k: 'create', id: 'b', props: { x: 0 } },
      { k: 'del', id: 'a' },
    ]
    const inv = invert(ops, sink.get)
    sink.apply(ops)
    sink.apply(inv)
    expect(Object.fromEntries(sink.nodes)).toEqual(before)
  })
})

describe('History', () => {
  it('undoes and redoes committed steps', () => {
    const sink = new MemSink()
    const h = new History(sink)
    h.commit([{ k: 'create', id: 'a', props: { x: 1 } }])
    h.commit([{ k: 'set', id: 'a', props: { x: 5 } }])
    h.undo()
    expect(sink.get('a')).toEqual({ x: 1 })
    h.undo()
    expect(sink.get('a')).toBeUndefined()
    h.redo()
    h.redo()
    expect(sink.get('a')).toEqual({ x: 5 })
    expect(h.canRedo).toBe(false)
  })

  it("leaves a teammate's edits to other properties alone", () => {
    const sink = new MemSink()
    sink.nodes.set('a', { x: 0, fill: 'red' })
    const h = new History(sink)
    h.commit([{ k: 'set', id: 'a', props: { x: 10 } }])
    sink.apply([{ k: 'set', id: 'a', props: { fill: 'blue' } }]) // remote edit
    h.undo()
    expect(sink.get('a')).toEqual({ x: 0, fill: 'blue' })
  })

  it('records a whole gesture as one step', () => {
    const sink = new MemSink()
    sink.nodes.set('a', { x: 0, y: 0 })
    const h = new History(sink)
    const snap = h.snapshot(['a', 'new'])
    for (let i = 1; i <= 10; i++) sink.apply([{ k: 'set', id: 'a', props: { x: i, y: i } }])
    sink.apply([{ k: 'create', id: 'new', props: { x: 1 } }])
    h.commitGesture(snap)
    h.undo()
    expect(Object.fromEntries(sink.nodes)).toEqual({ a: { x: 0, y: 0 } })
  })

  it('ignores gestures that changed nothing', () => {
    const sink = new MemSink()
    sink.nodes.set('a', { x: 0, pts: [[0, 0]] })
    const h = new History(sink)
    h.commitGesture(h.snapshot(['a']))
    expect(h.canUndo).toBe(false)
  })
})

describe('geometry', () => {
  const box = { x: 0, y: 0, w: 100, h: 50 }

  it('resizes from each side and flips past the opposite edge', () => {
    expect(resizeBox(box, 'se', 10, 10)).toEqual({ x: 0, y: 0, w: 110, h: 60 })
    expect(resizeBox(box, 'w', 20, 99)).toEqual({ x: 20, y: 0, w: 80, h: 50 })
    expect(resizeBox(box, 'e', -150, 0)).toEqual({ x: -50, y: 0, w: 50, h: 50 })
  })

  it('keeps aspect ratio on corner handles', () => {
    const r = resizeBox(box, 'se', 100, 0, true)
    expect(r.w / r.h).toBeCloseTo(2)
    expect(r).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    const nw = resizeBox(box, 'nw', -100, 0, true)
    expect(nw).toEqual({ x: -100, y: -50, w: 200, h: 100 })
  })

  it('maps child boxes proportionally', () => {
    expect(mapBox({ x: 50, y: 25, w: 50, h: 25 }, box, { x: 0, y: 0, w: 200, h: 100 })).toEqual({ x: 100, y: 50, w: 100, h: 50 })
  })

  it('round-trips screen and world coordinates and zooms around a point', () => {
    const cam = { x: 30, y: -20, z: 2 }
    const [wx, wy] = screenToWorld(cam, 100, 80)
    expect(worldToScreen(cam, wx, wy)).toEqual([100, 80])
    const z = zoomAt(cam, 100, 80, 1.5)
    expect(worldToScreen(z, wx, wy)).toEqual([100, 80])
    expect(zoomAt(cam, 0, 0, 1000).z).toBe(8)
  })

  it('fits content into the viewport', () => {
    const cam = fitCamera({ x: 0, y: 0, w: 1000, h: 500 }, 600, 400, 50)
    expect(cam.z).toBeCloseTo(0.5)
    expect(worldToScreen(cam, 500, 250)).toEqual([300, 200])
  })

  it('drops points that are too close together', () => {
    expect(simplify([[0, 0], [0.5, 0], [3, 0], [3.2, 0], [10, 0]], 2)).toEqual([[0, 0], [3, 0], [10, 0]])
  })
})

describe('toView', () => {
  it('fills defaults and rejects malformed values', () => {
    const v = toView('a', { type: 'path', x: 'nope', points: [[0, 1], ['x', 2], [1, 0]] })
    expect(v.type).toBe('path')
    expect(v.x).toBe(0)
    expect(v.points).toEqual([[0, 1], [1, 0]])
    expect(v.stroke).toBe('#161A23')
    expect(toView('b', { type: 'hexagon' }).type).toBe('rect')
  })
})
