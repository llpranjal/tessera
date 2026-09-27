export interface DocRow {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  nodeCount: number
}

export interface DocSummary extends DocRow {
  editors: { name: string; color: string }[]
}

export interface ServerStats {
  rooms: number
  peers: number
  connectionsTotal: number
  batches: number
  opsApplied: number
  messagesOut: number
  evictions: number
  uptimeSecs: number
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Request failed with status ${res.status}`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  list: () => request<DocSummary[]>('GET', '/api/docs'),
  create: (name?: string) => request<DocRow>('POST', '/api/docs', name ? { name } : {}),
  get: (id: string) => request<DocRow>('GET', `/api/docs/${id}`),
  rename: (id: string, name: string) => request<DocRow>('PATCH', `/api/docs/${id}`, { name }),
  remove: (id: string) => request<void>('DELETE', `/api/docs/${id}`),
  stats: () => request<ServerStats>('GET', '/api/stats'),
  thumbnailUrl: (id: string, v: number) => `/api/docs/${id}/thumbnail.svg?v=${v}`,
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 30) return d === 1 ? 'yesterday' : `${d} days ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
