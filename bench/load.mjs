// Load test: N clients per room, each sending `rate` edit batches per second.
// Every batch carries its send time; receivers record fan-out latency
// (send -> delivered to another client). Clients share one process and clock.
//
//   node bench/load.mjs [base=http://localhost:8787] [rooms=1] [clients=50] [rate=20] [seconds=10]

const [base = 'http://localhost:8787', rooms = '1', clients = '50', rate = '20', seconds = '10'] = process.argv.slice(2)
const R = +rooms, N = +clients, HZ = +rate, SECS = +seconds
const wsBase = base.replace(/^http/, 'ws')

const lat = []
let sent = 0, acked = 0, received = 0
const sockets = []

async function room(r) {
  const res = await fetch(`${base}/api/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `load ${r}` }) })
  const { id } = await res.json()
  const ready = []
  for (let c = 0; c < N; c++) {
    const ws = new WebSocket(`${wsBase}/ws/${id}?name=load-${r}-${c}`)
    sockets.push(ws)
    ready.push(new Promise((ok) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.t === 'welcome') {
          ws.send(JSON.stringify({ t: 'ops', seq: 0, ops: [{ k: 'create', id: `n${r}-${c}`, props: { x: 0, t: 0 } }] }))
          ok()
        } else if (m.t === 'ack') acked++
        else if (m.t === 'ops') {
          received++
          const t = m.ops[0].props?.t
          if (t) lat.push(performance.now() - t)
        }
      }
    }))
    ws.__meta = { r, c, seq: 1 }
  }
  await Promise.all(ready)
}

await Promise.all(Array.from({ length: R }, (_, r) => room(r)))
await new Promise((r) => setTimeout(r, 500))
lat.length = 0; received = 0; acked = 0

const start = performance.now()
const timers = sockets.map((ws) =>
  setInterval(() => {
    const { r, c } = ws.__meta
    ws.send(JSON.stringify({ t: 'ops', seq: ws.__meta.seq++, ops: [{ k: 'set', id: `n${r}-${c}`, props: { x: Math.random() * 1000, t: performance.now() } }] }))
    sent++
  }, 1000 / HZ),
)
await new Promise((r) => setTimeout(r, SECS * 1000))
timers.forEach(clearInterval)
await new Promise((r) => setTimeout(r, 1000))
const elapsed = (performance.now() - start - 1000) / 1000

lat.sort((a, b) => a - b)
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]?.toFixed(2)
const expected = sent * (N - 1)
console.log(JSON.stringify({
  rooms: R, clientsPerRoom: N, batchesPerClientPerSec: HZ, seconds: SECS,
  batchesSent: sent, acks: acked,
  deliveries: received, expectedDeliveries: expected, deliveryRate: (received / expected).toFixed(4),
  inboundBatchesPerSec: Math.round(sent / elapsed), outboundMsgsPerSec: Math.round(received / elapsed),
  latencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat.at(-1)?.toFixed(2) },
}, null, 2))
sockets.forEach((ws) => ws.close())
process.exit(0)
