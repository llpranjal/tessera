import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, timeAgo, type DocSummary, type ServerStats } from '../lib/api'
import { getName, setName } from '../lib/identity'
import { navigate } from '../lib/router'
import { Avatar, Logo } from '../ui/Brand'
import { HeroCanvas } from './HeroCanvas'

export function Dashboard() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.list(), api.stats()])
      setDocs(d)
      setStats(s)
      setError(null)
    } catch {
      setError("Can't reach the Tessera server. Check that it's running on port 8787, then reload.")
    }
  }, [])

  // Poll so live editor counts stay current.
  useEffect(() => {
    document.title = 'Files – Tessera'
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  const create = async () => {
    setCreating(true)
    try {
      const doc = await api.create()
      navigate(`/file/${doc.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a file')
      setCreating(false)
    }
  }

  const live = docs?.reduce((n, d) => n + d.editors.length, 0) ?? 0

  return (
    <div className="dash">
      <header className="dash-top">
        <div className="wordmark">
          <Logo size={26} />
          <span>Tessera</span>
        </div>
        <NameChip />
      </header>

      <section className="dash-hero">
        <div className="hero-copy">
          <h1>Design together, in the same file, at the same time.</h1>
          <p>
            Tessera is a multiplayer canvas. Every edit travels through a Rust server that puts it in order and sends it
            to everyone else in the file, so all collaborators end up with the same picture.
          </p>
        </div>
        <HeroCanvas />
      </section>

      <section className="dash-files" aria-labelledby="files-h">
        <div className="dash-files-head">
          <h2 id="files-h">
            Files
            {live > 0 && (
              <span className="live-count">
                <span className="pulse" /> {live} {live === 1 ? 'person' : 'people'} editing now
              </span>
            )}
          </h2>
          <button className="btn primary" onClick={create} disabled={creating}>
            <Plus size={16} /> New file
          </button>
        </div>

        {error && <p className="banner-error" role="alert">{error}</p>}

        {docs === null && !error ? (
          <div className="file-grid" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="file-card skeleton" />)}
          </div>
        ) : docs && docs.length === 0 ? (
          <div className="empty">
            <p>No files yet. Start one and share the link with someone.</p>
            <button className="btn primary" onClick={create}><Plus size={16} /> New file</button>
          </div>
        ) : (
          <ul className="file-grid">
            {docs?.map((d) => <FileCard key={d.id} doc={d} onChange={refresh} />)}
          </ul>
        )}
      </section>

      <footer className="dash-foot">
        {stats && (
          <p>
            Server up {formatUptime(stats.uptimeSecs)}. {stats.opsApplied.toLocaleString()} edits applied in{' '}
            {stats.batches.toLocaleString()} batches, {stats.messagesOut.toLocaleString()} messages sent,{' '}
            {stats.peers} {stats.peers === 1 ? 'connection' : 'connections'} open.
          </p>
        )}
        <p>
          Built with Rust (Axum, Tokio, SQLite) and TypeScript (React).{' '}
          <a href="https://github.com/llpranjal/tessera" target="_blank" rel="noreferrer">Source on GitHub</a>
        </p>
      </footer>
    </div>
  )
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} hr ${Math.floor((s % 3600) / 60)} min`
}

function FileCard({ doc, onChange }: { doc: DocSummary; onChange: () => void }) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const ref = useRef<HTMLLIElement>(null)
  const open = () => navigate(`/file/${doc.id}`)

  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  return (
    <li className="file-card" ref={ref}>
      <a className="thumb" href={`/file/${doc.id}`} onClick={(e) => { e.preventDefault(); open() }} aria-label={`Open ${doc.name}`}>
        <img src={api.thumbnailUrl(doc.id, doc.updatedAt + doc.nodeCount)} alt="" loading="lazy" />
        {doc.editors.length > 0 && (
          <span className="thumb-live">
            <span className="avatars">
              {doc.editors.slice(0, 4).map((e, i) => <Avatar key={i} name={e.name} color={e.color} size={22} ring />)}
            </span>
            {doc.editors.length} editing
          </span>
        )}
      </a>
      <div className="file-meta">
        {renaming ? (
          <input
            className="file-rename"
            autoFocus
            defaultValue={doc.name}
            aria-label="File name"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={async (e) => {
              const name = e.currentTarget.value.trim()
              setRenaming(false)
              if (name && name !== doc.name) {
                await api.rename(doc.id, name).catch(() => {})
                onChange()
              }
            }}
          />
        ) : (
          <div>
            <h3>{doc.name}</h3>
            <p>
              Edited {timeAgo(doc.updatedAt)}, {doc.nodeCount} {doc.nodeCount === 1 ? 'layer' : 'layers'}
            </p>
          </div>
        )}
        <div className="menu-wrap">
          <button className="icon-btn" aria-label={`Options for ${doc.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={16} />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true) }}><Pencil size={14} /> Rename</button>
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); setConfirming(true) }}><Trash2 size={14} /> Delete</button>
            </div>
          )}
        </div>
      </div>
      {confirming && (
        <div className="confirm" role="alertdialog" aria-label={`Delete ${doc.name}?`}>
          <p>Delete “{doc.name}” for everyone? This can't be undone.</p>
          <div className="confirm-actions">
            <button className="btn ghost" onClick={() => setConfirming(false)}>Keep file</button>
            <button className="btn danger" onClick={async () => { await api.remove(doc.id).catch(() => {}); onChange() }}>Delete file</button>
          </div>
        </div>
      )}
    </li>
  )
}

function NameChip() {
  const [name, setLocal] = useState(getName())
  const [editing, setEditing] = useState(false)
  return (
    <div className="name-chip">
      <Avatar name={name} color="#161A23" size={26} />
      {editing ? (
        <input
          autoFocus
          defaultValue={name}
          aria-label="Your name"
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => {
            setName(e.currentTarget.value)
            setLocal(getName())
            setEditing(false)
          }}
        />
      ) : (
        <button onClick={() => setEditing(true)} aria-label="Change your name" data-tip="Collaborators see this name">
          {name}
        </button>
      )}
    </div>
  )
}
