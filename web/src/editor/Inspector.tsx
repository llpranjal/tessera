import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Copy, Crosshair, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Props } from '../sync/protocol'
import { Avatar } from '../ui/Brand'
import { arrange, placeCopies, remove, selectedProps, type Arrange } from './actions'
import { useEditor } from './context'
import type { Snapshot } from './history'
import { round, SWATCHES, TYPE_LABEL, type NodeView } from './model'

type Phase = 'live' | 'commit'

/** One value if every node agrees, otherwise null ("Mixed"). */
function shared<T>(nodes: NodeView[], pick: (n: NodeView) => T): T | null {
  if (!nodes.length) return null
  const first = pick(nodes[0])
  return nodes.every((n) => pick(n) === first) ? first : null
}

export function Inspector() {
  const ed = useEditor()
  const { selection, byId, client, history, views } = ed
  const nodes = selection.map((id) => byId.get(id)).filter((n): n is NodeView => !!n)
  const gestureSnap = useRef<Snapshot | null>(null)

  if (!nodes.length) return <FilePanel />

  /** Edit every selected node. Live edits during a scrub become one undo step. */
  const edit = (props: (n: NodeView) => Props, phase: Phase) => {
    const ops = nodes
      .map((n) => ({ k: 'set' as const, id: n.id, props: props(n) }))
      .filter((op) => Object.entries(op.props).some(([k, v]) => client.get(op.id)?.[k] !== v))
    if (!ops.length && !gestureSnap.current) return
    if (phase === 'live') {
      gestureSnap.current ??= history.snapshot(selection)
      client.apply(ops)
    } else if (gestureSnap.current) {
      client.apply(ops)
      history.commitGesture(gestureSnap.current)
      gestureSnap.current = null
    } else {
      ed.commit(ops)
    }
  }
  const set = (key: string) => (v: number | string, phase: Phase) => edit(() => ({ [key]: v }), phase)

  const types = new Set(nodes.map((n) => n.type))
  const onlyText = types.size === 1 && types.has('text')
  const hasFill = [...types].some((t) => t !== 'path')
  const hasStroke = [...types].some((t) => t !== 'text')
  const title = nodes.length === 1 ? TYPE_LABEL[nodes[0].type] : `${nodes.length} layers`
  const doArrange = (dir: Arrange) => ed.commit(arrange(views, selection, dir))

  return (
    <aside className="panel inspector" aria-label="Design">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>

      <Section title="Layout">
        <div className="field-grid">
          <NumberField label="X" value={shared(nodes, (n) => round(n.x))} onChange={(v, p) => {
            const dx = v - Math.min(...nodes.map((n) => n.x))
            edit((n) => ({ x: round(nodes.length === 1 ? v : n.x + dx) }), p)
          }} />
          <NumberField label="Y" value={shared(nodes, (n) => round(n.y))} onChange={(v, p) => {
            const dy = v - Math.min(...nodes.map((n) => n.y))
            edit((n) => ({ y: round(nodes.length === 1 ? v : n.y + dy) }), p)
          }} />
          <NumberField label="W" min={1} value={shared(nodes, (n) => round(n.w))} onChange={set('w')} />
          <NumberField label="H" min={1} value={shared(nodes, (n) => round(n.h))} onChange={set('h')} disabled={onlyText} />
        </div>
      </Section>

      <Section title="Appearance">
        <div className="field-grid">
          <NumberField label="Opacity" suffix="%" min={0} max={100} value={shared(nodes, (n) => Math.round(n.opacity * 100))} onChange={(v, p) => edit(() => ({ opacity: v / 100 }), p)} />
          {types.size === 1 && types.has('rect') && (
            <NumberField label="Radius" min={0} value={shared(nodes, (n) => n.radius)} onChange={set('radius')} />
          )}
        </div>
      </Section>

      {hasFill && (
        <Section title={onlyText ? 'Text color' : 'Fill'}>
          <ColorField value={shared(nodes.filter((n) => n.type !== 'path'), (n) => n.fill)} onChange={(c, p) => edit((n): Props => (n.type === 'path' ? {} : { fill: c }), p)} />
        </Section>
      )}

      {hasStroke && (
        <Section title="Stroke">
          <ColorField
            value={shared(nodes.filter((n) => n.type !== 'text'), (n) => n.stroke ?? 'none')}
            allowNone
            onChange={(c, p) =>
              edit((n): Props => (n.type === 'text' ? {} : c === 'none' ? { stroke: null } : { stroke: c, strokeWidth: n.strokeWidth || 2 }), p)
            }
          />
          <div className="field-grid">
            <NumberField label="Width" min={0} max={64} value={shared(nodes.filter((n) => n.type !== 'text'), (n) => n.strokeWidth)} onChange={(v, p) => edit((n): Props => (n.type === 'text' ? {} : { strokeWidth: v }), p)} />
          </div>
        </Section>
      )}

      {onlyText && (
        <Section title="Type">
          <div className="field-grid">
            <NumberField label="Size" min={6} max={400} value={shared(nodes, (n) => n.fontSize)} onChange={set('fontSize')} />
            <label className="select-field">
              <select value={shared(nodes, (n) => n.fontWeight) ?? ''} onChange={(e) => set('fontWeight')(Number(e.target.value), 'commit')} aria-label="Font weight">
                {shared(nodes, (n) => n.fontWeight) === null && <option value="">Mixed</option>}
                <option value={400}>Regular</option>
                <option value={500}>Medium</option>
                <option value={600}>Semibold</option>
                <option value={700}>Bold</option>
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
        </Section>
      )}

      <Section title="Arrange">
        <div className="icon-row">
          <IconButton label="Bring to front" onClick={() => doArrange('front')}><ArrowUpToLine size={16} /></IconButton>
          <IconButton label="Bring forward" onClick={() => doArrange('forward')}><ChevronUp size={16} /></IconButton>
          <IconButton label="Send backward" onClick={() => doArrange('backward')}><ChevronDown size={16} /></IconButton>
          <IconButton label="Send to back" onClick={() => doArrange('back')}><ArrowDownToLine size={16} /></IconButton>
          <span className="icon-row-gap" />
          <IconButton label="Duplicate" onClick={() => {
            const { ops, ids } = placeCopies(views, selectedProps(views, selection, (id) => client.get(id)), 16, 16)
            ed.commit(ops)
            ed.setSelection(ids)
          }}><Copy size={16} /></IconButton>
          <IconButton label="Delete" danger onClick={() => { ed.commit(remove(selection)); ed.setSelection([]) }}><Trash2 size={16} /></IconButton>
        </div>
      </Section>
    </aside>
  )
}

function FilePanel() {
  const { snap, views, jumpTo } = useEditor()
  const peers = [...snap.peers.values()]
  return (
    <aside className="panel inspector" aria-label="File">
      <div className="panel-head">
        <h2>In this file</h2>
      </div>
      <Section title={`People (${peers.length + 1})`}>
        <ul className="people">
          {snap.me && (
            <li>
              <Avatar name={snap.me.name} color={snap.me.color} size={24} />
              <span className="person-name">{snap.me.name}</span>
              <span className="person-you">you</span>
            </li>
          )}
          {peers.map((p) => (
            <li key={p.sid}>
              <Avatar name={p.name} color={p.color} size={24} />
              <span className="person-name">{p.name}</span>
              {p.cursor && (
                <button className="link-btn" onClick={() => jumpTo(p.cursor![0], p.cursor![1])} aria-label={`Go to ${p.name}`}>
                  <Crosshair size={14} /> Find
                </button>
              )}
            </li>
          ))}
        </ul>
        {peers.length === 0 && <p className="hint">Share the link or open this file in another window to edit together.</p>}
      </Section>
      <Section title="Document">
        <dl className="facts">
          <dt>Layers</dt>
          <dd>{views.length}</dd>
          <dt>Server version</dt>
          <dd>{snap.version}</dd>
          <dt>Unsent changes</dt>
          <dd>{snap.pendingBatches}</dd>
        </dl>
      </Section>
      <Section title="Shortcuts">
        <dl className="shortcuts">
          {[
            ['Undo / redo', '⌘Z  ⇧⌘Z'],
            ['Duplicate', '⌘D'],
            ['Copy / paste', '⌘C  ⌘V'],
            ['Pan', 'Space + drag'],
            ['Zoom', '⌘ + scroll'],
            ['Zoom to fit', '⇧1'],
            ['Layer order', '[  ]'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd><kbd>{v}</kbd></dd>
            </div>
          ))}
        </dl>
      </Section>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button className={`icon-btn${danger ? ' danger' : ''}`} onClick={onClick} aria-label={label} data-tip={label}>
      {children}
    </button>
  )
}

/** Numeric input. Drag the label to scrub, or type and press Enter. */
function NumberField({
  label, value, onChange, min = -Infinity, max = Infinity, suffix, disabled,
}: {
  label: string
  value: number | null
  onChange: (v: number, phase: Phase) => void
  min?: number
  max?: number
  suffix?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const scrub = useRef<{ x: number; start: number; moved: boolean } | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  const commitDraft = () => {
    if (draft === null) return
    const v = Number(draft)
    setDraft(null)
    if (draft.trim() !== '' && Number.isFinite(v)) onChange(clamp(v), 'commit')
  }

  return (
    <div className={`num-field${disabled ? ' disabled' : ''}`}>
      <span
        className="num-label"
        onPointerDown={(e) => {
          if (disabled || value === null) return
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub.current = { x: e.clientX, start: value, moved: false }
        }}
        onPointerMove={(e) => {
          const s = scrub.current
          if (!s) return
          const dx = e.clientX - s.x
          if (!s.moved && Math.abs(dx) < 2) return
          s.moved = true
          onChange(clamp(Math.round(s.start + dx * (e.shiftKey ? 10 : 1))), 'live')
        }}
        onPointerUp={(e) => {
          const s = scrub.current
          scrub.current = null
          if (s?.moved) onChange(clamp(Math.round(s.start + (e.clientX - s.x) * (e.shiftKey ? 10 : 1))), 'commit')
        }}
      >
        {label}
      </span>
      <input
        inputMode="decimal"
        disabled={disabled}
        aria-label={label}
        value={draft ?? (value === null ? '' : String(value))}
        placeholder={value === null ? 'Mixed' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== null) {
            e.preventDefault()
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)), 'commit')
          }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </div>
  )
}

function ColorField({ value, onChange, allowNone }: { value: string | null; onChange: (c: string, phase: Phase) => void; allowNone?: boolean }) {
  const [hex, setHex] = useState<string | null>(null)
  const isHex = value !== null && /^#[0-9a-f]{6}$/i.test(value)
  return (
    <div className="color-field">
      <div className="swatches">
        {allowNone && (
          <button className={`swatch none${value === 'none' ? ' active' : ''}`} aria-label="No stroke" onClick={() => onChange('none', 'commit')} />
        )}
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`swatch${value?.toLowerCase() === c.toLowerCase() ? ' active' : ''}`}
            style={{ background: c }}
            aria-label={c}
            onClick={() => onChange(c, 'commit')}
          />
        ))}
      </div>
      <div className="hex-row">
        <label className="picker" style={{ background: isHex ? value! : 'transparent' }}>
          <input
            type="color"
            value={isHex ? value! : '#000000'}
            onChange={(e) => onChange(e.target.value, 'live')}
            onBlur={(e) => onChange(e.target.value, 'commit')}
            aria-label="Custom color"
          />
        </label>
        <input
          className="hex-input"
          aria-label="Hex color"
          value={hex ?? (value === null ? '' : value === 'none' ? 'None' : value.toUpperCase())}
          placeholder={value === null ? 'Mixed' : undefined}
          onChange={(e) => setHex(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={() => {
            const v = hex?.trim()
            setHex(null)
            if (!v) return
            const full = v.startsWith('#') ? v : `#${v}`
            if (/^#[0-9a-f]{6}$/i.test(full)) onChange(full.toUpperCase(), 'commit')
          }}
        />
      </div>
    </div>
  )
}
