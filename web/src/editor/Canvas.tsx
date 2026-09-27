import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Op, Props } from '../sync/protocol'
import { useEditor } from './context'
import {
  boxFromPoints,
  handlePoint,
  HANDLES,
  intersects,
  mapBox,
  resizeBox,
  screenToWorld,
  simplify,
  smoothPath,
  unionBox,
  worldToScreen,
  zoomAt,
  type Box,
  type Camera,
  type Handle,
} from './geometry'
import type { Snapshot } from './history'
import { newId, round, type NodeView } from './model'
import { newIndex } from './actions'
import { NodeShape, TextEditor } from './NodeShape'

type Pt = [number, number]

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; cam: Camera }
  | { kind: 'move'; origin: Pt; starts: NodeView[]; snap: Snapshot; moved: boolean; clicked: string; shift: boolean }
  | { kind: 'resize'; origin: Pt; handle: Handle; box: Box; starts: NodeView[]; snap: Snapshot }
  | { kind: 'create'; origin: Pt; id: string; snap: Snapshot; moved: boolean }
  | { kind: 'marquee'; origin: Pt; base: string[] }
  | { kind: 'draw'; points: Pt[] }

const CLICK_SLOP = 3
const DEFAULT_SIZE = 120

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
}

function textHeight(id: string): number | null {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"] .text-node`)
  return el ? el.offsetHeight : null
}

export function Canvas({ viewport: wrap }: { viewport: RefObject<HTMLDivElement | null> }) {
  const ed = useEditor()
  const { client, history, views, byId, selection, setSelection, tool, camera, setCamera, editing, panMode } = ed
  const gesture = useRef<Gesture | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [draft, setDraft] = useState<Pt[] | null>(null)
  const [panning, setPanning] = useState(false)
  const cam = useRef(camera)
  useLayoutEffect(() => {
    cam.current = camera
  }, [camera])

  const selected = useMemo(() => selection.map((id) => byId.get(id)).filter((v): v is NodeView => !!v), [selection, byId])
  const selBox = useMemo(() => unionBox(selected), [selected])

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrap.current!.getBoundingClientRect()
    return screenToWorld(cam.current, e.clientX - r.left, e.clientY - r.top)
  }

  // Wheel: pan, or zoom with ctrl/cmd (trackpad pinch arrives as ctrl+wheel).
  useEffect(() => {
    const el = wrap.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : 1
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * scale * 0.01)
        setCamera((c) => zoomAt(c, e.clientX - r.left, e.clientY - r.top, factor))
      } else {
        setCamera((c) => ({ ...c, x: c.x - e.deltaX * scale, y: c.y - e.deltaY * scale }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wrap, setCamera])

  const shapeDefaults = (type: 'rect' | 'ellipse', x: number, y: number): Props => ({
    type,
    x: round(x),
    y: round(y),
    w: 1,
    h: 1,
    fill: ed.myColor,
    radius: type === 'rect' ? 8 : 0,
    index: newIndex(views),
  })

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button === 2) return
    const target = e.target as Element
    if (target.closest('.text-node.editing')) return
    wrap.current!.setPointerCapture(e.pointerId)
    const origin = toWorld(e)
    if (e.button === 1 || tool === 'hand' || panMode) {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: cam.current }
      setPanning(true)
      return
    }
    if (editing) ed.finishEditing()

    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | undefined
    const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? undefined

    switch (tool) {
      case 'select': {
        if (handle && selBox) {
          gesture.current = { kind: 'resize', origin, handle, box: selBox, starts: selected, snap: history.snapshot(selection) }
          return
        }
        if (nodeId) {
          let sel = selection
          if (e.shiftKey) {
            sel = sel.includes(nodeId) ? sel.filter((id) => id !== nodeId) : [...sel, nodeId]
            setSelection(sel)
          } else if (!sel.includes(nodeId)) {
            sel = [nodeId]
            setSelection(sel)
          }
          const starts = sel.map((id) => byId.get(id)).filter((v): v is NodeView => !!v)
          gesture.current = { kind: 'move', origin, starts, snap: history.snapshot(sel), moved: false, clicked: nodeId, shift: e.shiftKey }
          return
        }
        gesture.current = { kind: 'marquee', origin, base: e.shiftKey ? selection : [] }
        if (!e.shiftKey) setSelection([])
        return
      }
      case 'rect':
      case 'ellipse': {
        const id = newId()
        const snap = history.snapshot([id])
        client.apply([{ k: 'create', id, props: shapeDefaults(tool, origin[0], origin[1]) }])
        setSelection([id])
        gesture.current = { kind: 'create', origin, id, snap, moved: false }
        return
      }
      case 'text': {
        const id = newId()
        const snap = history.snapshot([id])
        client.apply([
          {
            k: 'create',
            id,
            props: { type: 'text', x: round(origin[0]), y: round(origin[1] - 14), w: 280, h: 30, text: '', fontSize: 24, fontWeight: 500, fill: '#161A23', index: newIndex(views) },
          },
        ])
        setSelection([id])
        ed.setTool('select')
        ed.startEditing(id, snap)
        gesture.current = null
        return
      }
      case 'path':
        gesture.current = { kind: 'draw', points: [origin] }
        setDraft([origin])
        return
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const [wx, wy] = toWorld(e)
    client.setPresence({ cursor: [round(wx, 1), round(wy, 1)] })
    const g = gesture.current
    if (!g) return
    const z = cam.current.z
    switch (g.kind) {
      case 'pan':
        setCamera({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy })
        return
      case 'move': {
        let dx = wx - g.origin[0]
        let dy = wy - g.origin[1]
        if (!g.moved && Math.hypot(dx, dy) * z < CLICK_SLOP) return
        g.moved = true
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        client.apply(g.starts.map((s) => ({ k: 'set', id: s.id, props: { x: round(s.x + dx), y: round(s.y + dy) } })))
        return
      }
      case 'resize': {
        const nb = resizeBox(g.box, g.handle, wx - g.origin[0], wy - g.origin[1], e.shiftKey)
        const ops: Op[] = g.starts.map((s) => {
          const b = mapBox(s, g.box, nb)
          const props: Props = { x: round(b.x), y: round(b.y), w: round(Math.max(1, b.w)) }
          if (s.type !== 'text') props.h = round(Math.max(1, b.h))
          return { k: 'set', id: s.id, props }
        })
        client.apply(ops)
        return
      }
      case 'create': {
        let b = boxFromPoints(g.origin[0], g.origin[1], wx, wy)
        if (e.shiftKey) {
          const s = Math.max(b.w, b.h)
          b = { x: wx < g.origin[0] ? g.origin[0] - s : g.origin[0], y: wy < g.origin[1] ? g.origin[1] - s : g.origin[1], w: s, h: s }
        }
        if (!g.moved && Math.max(b.w, b.h) * z < CLICK_SLOP) return
        g.moved = true
        client.apply([{ k: 'set', id: g.id, props: { x: round(b.x), y: round(b.y), w: round(Math.max(1, b.w)), h: round(Math.max(1, b.h)) } }])
        return
      }
      case 'marquee': {
        const b = boxFromPoints(g.origin[0], g.origin[1], wx, wy)
        setMarquee(b)
        const hits = views.filter((v) => intersects(v, b)).map((v) => v.id)
        setSelection([...new Set([...g.base, ...hits])])
        return
      }
      case 'draw':
        g.points.push([wx, wy])
        setDraft([...g.points])
        return
    }
  }

  function onPointerUp() {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    switch (g.kind) {
      case 'pan':
        setPanning(false)
        return
      case 'move':
        if (g.moved) history.commitGesture(g.snap)
        else if (!g.shift && selection.length > 1) setSelection([g.clicked])
        return
      case 'resize': {
        // Text wraps to its new width; record the resulting height.
        const ops: Op[] = []
        for (const s of g.starts) {
          if (s.type !== 'text') continue
          const h = textHeight(s.id)
          if (h) ops.push({ k: 'set', id: s.id, props: { h } })
        }
        client.apply(ops)
        history.commitGesture(g.snap)
        return
      }
      case 'create':
        if (!g.moved) {
          client.apply([{ k: 'set', id: g.id, props: { x: round(g.origin[0] - DEFAULT_SIZE / 2), y: round(g.origin[1] - DEFAULT_SIZE / 2), w: DEFAULT_SIZE, h: DEFAULT_SIZE } }])
        }
        history.commitGesture(g.snap)
        ed.setTool('select')
        return
      case 'marquee':
        setMarquee(null)
        return
      case 'draw': {
        setDraft(null)
        const pts = simplify(g.points, 1.5 / cam.current.z)
        if (pts.length < 2) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5])
        const b = boxFromPoints(
          Math.min(...pts.map((p) => p[0])),
          Math.min(...pts.map((p) => p[1])),
          Math.max(...pts.map((p) => p[0])),
          Math.max(...pts.map((p) => p[1])),
        )
        const w = Math.max(b.w, 1)
        const h = Math.max(b.h, 1)
        const points = pts.map(([x, y]) => [round((x - b.x) / w, 4), round((y - b.y) / h, 4)])
        ed.commit([
          {
            k: 'create',
            id: newId(),
            props: { type: 'path', x: round(b.x), y: round(b.y), w: round(w), h: round(h), points, stroke: ed.myColor, strokeWidth: 4, index: newIndex(views) },
          },
        ])
        return
      }
    }
  }

  function onDoubleClick(e: React.MouseEvent) {
    const id = (e.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id')
    if (id && byId.get(id)?.type === 'text') ed.startEditing(id)
  }

  const z = camera.z
  const grid = 24 * z * (z < 0.5 ? 4 : 1)
  const editingNode = editing ? byId.get(editing.id) : undefined
  const peers = [...ed.snap.peers.values()]

  return (
    <div
      ref={wrap}
      className={`canvas tool-${tool}${panMode ? ' pan-mode' : ''}${panning ? ' panning' : ''}`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => client.setPresence({ cursor: null })}
      onDoubleClick={onDoubleClick}
      role="application"
      aria-label="Canvas"
    >
      <svg className="canvas-svg">
        <g transform={`translate(${camera.x} ${camera.y}) scale(${z})`}>
          {views.map((v) => (
            <NodeShape key={v.id} node={v} hidden={editing?.id === v.id} />
          ))}
          {editingNode && (
            <TextEditor
              key={editingNode.id}
              node={editingNode}
              onInput={(text, h) => client.apply([{ k: 'set', id: editingNode.id, props: { text, h } }])}
              onDone={ed.finishEditing}
            />
          )}
          {draft && <path d={smoothPath(draft)} fill="none" stroke={ed.myColor} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />}

          {peers.map((p) => {
            const nodes = p.selection.map((id) => byId.get(id)).filter((v): v is NodeView => !!v)
            const box = unionBox(nodes)
            if (!box) return null
            return (
              <g key={p.sid} className="remote-selection">
                {nodes.map((v) => (
                  <rect key={v.id} x={v.x} y={v.y} width={v.w} height={v.h} stroke={p.color} strokeWidth={2 / z} />
                ))}
                <g transform={`translate(${box.x} ${box.y}) scale(${1 / z})`}>
                  <rect className="remote-tag" x={0} y={-20} width={p.name.length * 6.4 + 12} height={17} rx={4} fill={p.color} />
                  <text className="remote-tag-text" x={6} y={-8}>{p.name}</text>
                </g>
              </g>
            )
          })}
          {ed.hoverId && !selection.includes(ed.hoverId) && byId.get(ed.hoverId) && (
            <HoverOutline node={byId.get(ed.hoverId)!} z={z} />
          )}
          {selBox && !editing && (
            <SelectionOverlay box={selBox} nodes={selected} z={z} showHandles={tool === 'select' && !panMode} />
          )}
          {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} strokeWidth={1 / z} />}
        </g>
      </svg>
      <Cursors camera={camera} />
    </div>
  )
}

function HoverOutline({ node, z }: { node: NodeView; z: number }) {
  return <rect className="hover-outline" x={node.x} y={node.y} width={node.w} height={node.h} strokeWidth={1.5 / z} />
}

function SelectionOverlay({ box, nodes, z, showHandles }: { box: Box; nodes: NodeView[]; z: number; showHandles: boolean }) {
  const hs = 8 / z
  return (
    <g className="selection">
      {nodes.length > 1 &&
        nodes.map((n) => <rect key={n.id} className="selection-member" x={n.x} y={n.y} width={n.w} height={n.h} strokeWidth={1 / z} />)}
      <rect className="selection-box" x={box.x} y={box.y} width={box.w} height={box.h} strokeWidth={1.5 / z} />
      {showHandles &&
        HANDLES.map((h) => {
          const [x, y] = handlePoint(box, h)
          return (
            <rect
              key={h}
              data-handle={h}
              className="handle"
              x={x - hs / 2}
              y={y - hs / 2}
              width={hs}
              height={hs}
              rx={1.5 / z}
              strokeWidth={1.5 / z}
              style={{ cursor: HANDLE_CURSOR[h] }}
            />
          )
        })}
      <g transform={`translate(${box.x + box.w / 2} ${box.y + box.h + 10 / z}) scale(${1 / z})`}>
        <SizeLabel w={box.w} h={box.h} />
      </g>
    </g>
  )
}

function SizeLabel({ w, h }: { w: number; h: number }) {
  const text = `${Math.round(w)} × ${Math.round(h)}`
  const width = text.length * 6.6 + 12
  return (
    <g className="size-label" pointerEvents="none">
      <rect x={-width / 2} y={0} width={width} height={18} rx={4} />
      <text x={0} y={12.5} textAnchor="middle">
        {text}
      </text>
    </g>
  )
}

function Cursors({ camera }: { camera: Camera }) {
  const { snap } = useEditor()
  return (
    <div className="cursors" aria-hidden>
      {[...snap.peers.values()].map((p) => {
        if (!p.cursor) return null
        const [x, y] = worldToScreen(camera, p.cursor[0], p.cursor[1])
        return (
          <div key={p.sid} className="cursor" style={{ transform: `translate(${x}px, ${y}px)`, ['--peer' as string]: p.color }}>
            <svg width="18" height="20" viewBox="0 0 18 20">
              <path d="M1.5 1.5 L16 10.2 L9.4 11.6 L6.3 18 Z" fill="var(--peer)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="cursor-label">{p.name}</span>
          </div>
        )
      })}
    </div>
  )
}
