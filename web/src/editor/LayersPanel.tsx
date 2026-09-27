import { Circle, PenLine, Square, Type } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { keyBetween } from '../sync/fractional'
import { useEditor } from './context'
import { displayName, type NodeType } from './model'

const ICONS: Record<NodeType, typeof Square> = { rect: Square, ellipse: Circle, text: Type, path: PenLine }

export function LayersPanel() {
  const { views, selection, setSelection, snap, setHoverId, commit } = useEditor()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; over: string | null; above: boolean } | null>(null)
  const topFirst = useMemo(() => [...views].reverse(), [views])

  // Which collaborators have each layer selected.
  const selectedBy = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const p of snap.peers.values()) for (const id of p.selection) m.set(id, [...(m.get(id) ?? []), p.color])
    return m
  }, [snap.peers])

  function click(id: string, shift: boolean) {
    if (shift) setSelection(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id])
    else setSelection([id])
  }

  function drop(e: DragEvent) {
    e.preventDefault()
    if (!drag?.over || drag.over === drag.id) return setDrag(null)
    // Rows are listed top-first, so "above" a row means a higher index.
    const others = views.filter((v) => v.id !== drag.id)
    const i = others.findIndex((v) => v.id === drag.over)
    const [lo, hi] = drag.above
      ? [others[i].index, others[i + 1]?.index ?? null]
      : [others[i - 1]?.index ?? null, others[i].index]
    try {
      commit([{ k: 'set', id: drag.id, props: { index: keyBetween(lo, hi) } }])
    } catch {
      // Equal neighbour keys from a concurrent insert: leave the order alone.
    }
    setDrag(null)
  }

  return (
    <aside className="panel layers" aria-label="Layers">
      <div className="panel-head">
        <h2>Layers</h2>
        <span className="count">{views.length}</span>
      </div>
      {views.length === 0 ? (
        <p className="panel-empty">Shapes you draw show up here. Press R to draw a rectangle.</p>
      ) : (
        <ul className="layer-list" onDragOver={(e) => e.preventDefault()} onDrop={drop} onDragEnd={() => setDrag(null)}>
          {topFirst.map((v) => {
            const Icon = ICONS[v.type]
            const isSel = selection.includes(v.id)
            const dots = selectedBy.get(v.id) ?? []
            const dropClass = drag?.over === v.id && drag.id !== v.id ? (drag.above ? ' drop-above' : ' drop-below') : ''
            return (
              <li
                key={v.id}
                className={`layer${isSel ? ' selected' : ''}${dropClass}`}
                draggable={renaming !== v.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDrag({ id: v.id, over: null, above: true })
                }}
                onDragOver={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  if (drag) setDrag({ ...drag, over: v.id, above: e.clientY < r.top + r.height / 2 })
                }}
                onClick={(e) => click(v.id, e.shiftKey)}
                onDoubleClick={() => setRenaming(v.id)}
                onPointerEnter={() => setHoverId(v.id)}
                onPointerLeave={() => setHoverId(null)}
              >
                <Icon size={14} strokeWidth={1.75} className="layer-icon" />
                {renaming === v.id ? (
                  <input
                    className="layer-rename"
                    autoFocus
                    defaultValue={displayName(v)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                      e.stopPropagation()
                    }}
                    onBlur={(e) => {
                      const name = e.currentTarget.value.trim()
                      if (renaming && name && name !== displayName(v)) commit([{ k: 'set', id: v.id, props: { name } }])
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <span className="layer-name">{displayName(v)}</span>
                )}
                <span className="layer-peers">
                  {dots.map((c, i) => (
                    <span key={i} className="peer-dot" style={{ background: c }} />
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
