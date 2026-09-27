import { Bot, Check, Link2, Minus, Plus, Scan } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { getName } from '../lib/identity'
import { navigate } from '../lib/router'
import { SyncClient, webSocketTransport, type SyncSnapshot } from '../sync/client'
import type { Op } from '../sync/protocol'
import { Avatar, Logo } from '../ui/Brand'
import { arrange, fromClipboard, nudge, placeCopies, remove, selectedProps, toClipboard } from './actions'
import { startDemoBot } from './bot'
import { Canvas } from './Canvas'
import { EditorContext, type EditorApi, type Editing } from './context'
import { fitCamera, unionBox, zoomAt, type Camera } from './geometry'
import { History, type Snapshot } from './history'
import { Inspector } from './Inspector'
import { LayersPanel } from './LayersPanel'
import { sortedViews, type Tool } from './model'
import { Toolbar } from './Toolbar'

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; client: SyncClient }

export function EditorPage({ docId }: { docId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let client: SyncClient | null = null
    let cancelled = false
    api.get(docId).then(
      () => {
        if (cancelled) return
        client = new SyncClient(webSocketTransport(docId, getName()))
        setLoad({ state: 'ready', client })
      },
      () => !cancelled && setLoad({ state: 'missing' }),
    )
    return () => {
      cancelled = true
      client?.dispose()
    }
  }, [docId])

  if (load.state === 'loading') return <div className="editor-loading" aria-busy="true" />
  if (load.state === 'missing') {
    return (
      <Notice title="This file doesn't exist" body="It may have been deleted, or the link is incomplete.">
        <button className="btn primary" onClick={() => navigate('/')}>Back to files</button>
      </Notice>
    )
  }
  return <Editor key={docId} client={load.client} docId={docId} />
}

function Notice({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="notice-screen">
      <div className="notice">
        <Logo size={28} />
        <h1>{title}</h1>
        <p>{body}</p>
        {children}
      </div>
    </div>
  )
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

function Editor({ client, docId }: { client: SyncClient; docId: string }) {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const views = useMemo(() => sortedViews(snap.nodes), [snap.nodes])
  const byId = useMemo(() => new Map(views.map((v) => [v.id, v])), [views])
  const history = useMemo(() => new History(client), [client])

  const [rawSelection, setSelection] = useState<string[]>([])
  const selection = useMemo(() => rawSelection.filter((id) => byId.has(id)), [rawSelection, byId])
  const [tool, setTool] = useState<Tool>('select')
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, z: 1 })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [panMode, setPanMode] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [bot, setBot] = useState<null | (() => void)>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const pasteCount = useRef(0)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200)
  }, [])

  useEffect(() => {
    client.onReject = (m) => showToast(`The server refused an edit: ${m}`)
  }, [client, showToast])

  // Share our selection with collaborators.
  useEffect(() => {
    client.setPresence({ selection })
  }, [client, selection])

  useEffect(() => () => bot?.(), [bot])

  const fit = useCallback(() => {
    const el = viewport.current
    const box = unionBox(views)
    if (!el) return
    if (!box) return setCamera({ x: el.clientWidth / 2, y: el.clientHeight / 2, z: 1 })
    setCamera(fitCamera(box, el.clientWidth, el.clientHeight, 80, 1))
  }, [views])

  // Fit the content once, when the document first arrives.
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || snap.status !== 'online') return
    fitted.current = true
    fit()
  }, [snap.status, fit])

  const jumpTo = useCallback((x: number, y: number) => {
    const el = viewport.current
    if (!el) return
    setCamera((c) => ({ ...c, x: el.clientWidth / 2 - x * c.z, y: el.clientHeight / 2 - y * c.z }))
  }, [])

  const zoomBy = useCallback((factor: number) => {
    const el = viewport.current
    if (el) setCamera((c) => zoomAt(c, el.clientWidth / 2, el.clientHeight / 2, factor))
  }, [])

  const commit = useCallback((ops: Op[]) => history.commit(ops), [history])

  const editingRef = useRef<Editing | null>(null)
  const startEditing = useCallback(
    (id: string, snapshot?: Snapshot) => {
      editingRef.current = { id, snap: snapshot ?? history.snapshot([id]) }
      setEditing(editingRef.current)
    },
    [history],
  )

  const finishEditing = useCallback(() => {
    const cur = editingRef.current
    if (!cur) return
    editingRef.current = null
    setEditing(null)
    const node = client.get(cur.id)
    // Empty text boxes are removed, like in most design tools.
    if (node && typeof node.text === 'string' && node.text.trim() === '') client.apply([{ k: 'del', id: cur.id }])
    history.commitGesture(cur.snap)
  }, [client, history])

  const api_: EditorApi = {
    client, history, snap, views, byId, selection, setSelection, tool, setTool, camera, setCamera,
    editing, startEditing, finishEditing, hoverId, setHoverId, panMode, commit, fit, jumpTo,
    myColor: snap.me?.color ?? '#2B3BEA',
  }

  // Keyboard shortcuts.
  const latest = useRef(api_)
  useLayoutEffect(() => {
    latest.current = api_
  })
  useEffect(() => {
    const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse', e: 'ellipse', t: 'text', p: 'path' }
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const ed = latest.current
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const handled = () => e.preventDefault()

      if (e.key === ' ') return (handled(), setPanMode(true))
      if (mod && key === 'z') return (handled(), e.shiftKey ? history.redo() : history.undo())
      if (mod && key === 'y') return (handled(), history.redo())
      if (mod && key === 'a') return (handled(), setSelection(ed.views.map((v) => v.id)))
      if (mod && key === 'd') {
        handled()
        const { ops, ids } = placeCopies(ed.views, selectedProps(ed.views, ed.selection, (id) => client.get(id)), 16, 16)
        commit(ops)
        return setSelection(ids)
      }
      if (mod && (key === '=' || key === '+')) return (handled(), zoomBy(1.25))
      if (mod && key === '-') return (handled(), zoomBy(0.8))
      if (mod && key === '0') {
        handled()
        const el = viewport.current!
        return setCamera((c) => zoomAt(c, el.clientWidth / 2, el.clientHeight / 2, 1 / c.z))
      }
      if (e.shiftKey && (e.code === 'Digit1' || key === '!')) return (handled(), ed.fit())
      if (e.key === '[' || e.key === ']') {
        handled()
        const dir = e.key === ']' ? (mod ? 'front' : 'forward') : mod ? 'back' : 'backward'
        return commit(arrange(ed.views, ed.selection, dir))
      }
      if (mod) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        handled()
        commit(remove(ed.selection))
        return setSelection([])
      }
      if (e.key === 'Escape') return ed.tool !== 'select' ? setTool('select') : setSelection([])
      if (e.key === 'Enter' && ed.selection.length === 1 && ed.byId.get(ed.selection[0])?.type === 'text') {
        handled()
        return startEditing(ed.selection[0])
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      if (arrows[e.key] && ed.selection.length) {
        handled()
        const step = e.shiftKey ? 10 : 1
        return commit(nudge(ed.views, ed.selection, arrows[e.key][0] * step, arrows[e.key][1] * step))
      }
      if (TOOL_KEYS[key] && !e.altKey) setTool(TOOL_KEYS[key])
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setPanMode(false)
    }
    const copy = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !latest.current.selection.length) return
      const ed = latest.current
      e.clipboardData?.setData('text/plain', toClipboard(selectedProps(ed.views, ed.selection, (id) => client.get(id))))
      e.preventDefault()
      pasteCount.current = 0
      if (e.type === 'cut') {
        commit(remove(ed.selection))
        setSelection([])
      }
    }
    const paste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return
      const props = fromClipboard(e.clipboardData?.getData('text/plain') ?? '')
      if (!props?.length) return
      e.preventDefault()
      const offset = 16 * ++pasteCount.current
      const { ops, ids } = placeCopies(latest.current.views, props, offset, offset)
      commit(ops)
      setSelection(ids)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', () => setPanMode(false))
    document.addEventListener('copy', copy)
    document.addEventListener('cut', copy)
    document.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', copy)
      document.removeEventListener('paste', paste)
    }
  }, [client, history, commit, zoomBy, startEditing])

  useEffect(() => {
    document.title = snap.docName ? `${snap.docName} – Tessera` : 'Tessera'
  }, [snap.docName])

  const toggleBot = () => {
    if (bot) {
      bot()
      setBot(null)
    } else {
      const stop = startDemoBot(docId)
      setBot(() => stop)
      showToast('A demo collaborator joined through a second WebSocket connection')
    }
  }

  return (
    <EditorContext.Provider value={api_}>
      <div className="editor">
        <Topbar docId={docId} snap={snap} onShare={() => {
          navigator.clipboard?.writeText(location.href).then(
            () => showToast('Link copied. Anyone with it can edit.'),
            () => showToast(location.href),
          )
        }} botActive={!!bot} onToggleBot={toggleBot} onJump={jumpTo} />
        <LayersPanel />
        <main className="stage">
          <Canvas viewport={viewport} />
          <Toolbar />
          <div className="zoom-controls">
            <button className="icon-btn" onClick={() => zoomBy(0.8)} aria-label="Zoom out"><Minus size={15} /></button>
            <button className="zoom-level" onClick={() => {
              const el = viewport.current!
              setCamera((c) => zoomAt(c, el.clientWidth / 2, el.clientHeight / 2, 1 / c.z))
            }} aria-label="Reset zoom to 100%">{Math.round(camera.z * 100)}%</button>
            <button className="icon-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in"><Plus size={15} /></button>
            <button className="icon-btn" onClick={fit} aria-label="Zoom to fit" data-tip="Zoom to fit  ⇧1"><Scan size={15} /></button>
          </div>
          {toast && <div className="toast" role="status"><Check size={15} /> {toast}</div>}
        </main>
        <Inspector />
        {snap.status === 'deleted' && (
          <div className="modal-backdrop">
            <Notice title="This file was deleted" body="Someone removed it while you were editing. Your recent changes can't be saved.">
              <button className="btn primary" onClick={() => navigate('/')}>Back to files</button>
            </Notice>
          </div>
        )}
      </div>
    </EditorContext.Provider>
  )
}

function Topbar({ docId, snap, onShare, botActive, onToggleBot, onJump }: {
  docId: string
  snap: SyncSnapshot
  onShare: () => void
  botActive: boolean
  onToggleBot: () => void
  onJump: (x: number, y: number) => void
}) {
  const [name, setName] = useState<string | null>(null)
  const peers = [...snap.peers.values()]
  const status =
    snap.status === 'online'
      ? snap.pendingBatches > 0 ? { label: 'Saving', cls: 'saving' } : { label: 'Saved', cls: 'online' }
      : snap.status === 'connecting'
        ? { label: 'Connecting', cls: 'saving' }
        : snap.status === 'offline'
          ? { label: 'Offline, reconnecting', cls: 'offline' }
          : { label: 'Deleted', cls: 'offline' }

  const saveName = () => {
    const next = name?.trim()
    setName(null)
    if (next && next !== snap.docName) api.rename(docId, next).catch(() => {})
  }

  return (
    <header className="topbar">
      <a className="brand-link" href="/" onClick={(e) => { e.preventDefault(); navigate('/') }} aria-label="All files">
        <Logo />
      </a>
      <div className="title-block">
        <a className="crumb" href="/" onClick={(e) => { e.preventDefault(); navigate('/') }}>Files</a>
        <span className="crumb-sep">/</span>
        <input
          className="doc-name"
          aria-label="File name"
          value={name ?? snap.docName}
          size={Math.max(8, (name ?? snap.docName).length)}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setName(null); e.currentTarget.blur() }
          }}
        />
        <span className={`status ${status.cls}`} role="status">
          <span className="status-dot" />
          {status.label}
        </span>
      </div>
      <div className="topbar-right">
        <div className="avatar-stack">
          {peers.slice(0, 5).map((p) => (
            <button key={p.sid} className="avatar-btn" onClick={() => p.cursor && onJump(p.cursor[0], p.cursor[1])} aria-label={`Go to ${p.name}`} data-tip={p.name}>
              <Avatar name={p.name} color={p.color} ring />
            </button>
          ))}
          {peers.length > 5 && <span className="avatar more">+{peers.length - 5}</span>}
          {snap.me && (
            <span className="avatar-btn me" data-tip={`${snap.me.name} (you)`}>
              <Avatar name={snap.me.name} color={snap.me.color} ring />
            </span>
          )}
        </div>
        <button className={`btn ghost${botActive ? ' on' : ''}`} onClick={onToggleBot} aria-pressed={botActive}>
          <Bot size={16} /> {botActive ? 'Remove demo bot' : 'Add demo bot'}
        </button>
        <button className="btn primary" onClick={onShare}>
          <Link2 size={16} /> Share
        </button>
      </div>
    </header>
  )
}
