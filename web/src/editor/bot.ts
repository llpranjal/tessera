// A scripted collaborator for demos. It is a genuine second client: its own
// SyncClient and WebSocket, so everything it does goes through the Rust server
// exactly like a person in another browser would.

import { SyncClient, webSocketTransport } from '../sync/client'
import { keyBetween } from '../sync/fractional'
import { unionBox } from './geometry'
import { newId, round, sortedViews, SWATCHES, type NodeView } from './model'

type Pt = [number, number]

export function startDemoBot(docId: string): () => void {
  const client = new SyncClient(webSocketTransport(docId, 'Demo bot'))
  const created: string[] = []
  let stopped = false
  let cursor: Pt = [0, 0]
  let selection: string[] = []

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
  const views = () => sortedViews(client.getSnapshot().nodes)
  const present = () => client.setPresence({ cursor: [round(cursor[0], 1), round(cursor[1], 1)], selection })

  /** Animate from 0..1 over `ms`, calling `step` each frame. */
  async function tween(ms: number, step: (t: number) => void) {
    const start = performance.now()
    for (;;) {
      if (stopped) return
      const t = Math.min(1, (performance.now() - start) / ms)
      step(ease(t))
      if (t >= 1) return
      await sleep(33)
    }
  }

  async function glide(to: Pt, ms = 700) {
    const from = cursor
    // Curve slightly so the motion reads as a hand, not a robot.
    const bend: Pt = [rand(-60, 60), rand(-60, 60)]
    await tween(ms, (t) => {
      const k = 4 * t * (1 - t)
      cursor = [from[0] + (to[0] - from[0]) * t + bend[0] * k, from[1] + (to[1] - from[1]) * t + bend[1] * k]
      present()
    })
  }

  async function nudgeShape(target: NodeView) {
    await glide([target.x + target.w / 2, target.y + target.h / 2])
    selection = [target.id]
    present()
    await sleep(250)
    const dx = rand(-70, 70)
    const dy = rand(-50, 50)
    for (const dir of [1, -1]) {
      const base = client.get(target.id)
      if (!base || typeof base.x !== 'number' || typeof base.y !== 'number') break
      const [bx, by] = [base.x, base.y]
      const [cx, cy] = cursor
      await tween(900, (t) => {
        client.apply([{ k: 'set', id: target.id, props: { x: round(bx + dx * dir * t), y: round(by + dy * dir * t) } }])
        cursor = [cx + dx * dir * t, cy + dy * dir * t]
        present()
      })
      await sleep(dir === 1 ? 700 : 150)
    }
    selection = []
    present()
  }

  async function drawShape() {
    const box = unionBox(views()) ?? { x: 0, y: 0, w: 600, h: 400 }
    const at: Pt = [box.x + rand(0, box.w), box.y + box.h + rand(40, 120)]
    await glide(at)
    const id = newId()
    const all = views()
    const type = Math.random() < 0.5 ? 'ellipse' : 'rect'
    const size = rand(70, 130)
    const color = client.getSnapshot().me?.color ?? '#E8457A'
    client.apply([{ k: 'create', id, props: { type, x: round(at[0]), y: round(at[1]), w: 1, h: 1, fill: color, radius: 14, name: 'Bot shape', index: keyBetween(all[all.length - 1]?.index || null, null) } }])
    created.push(id)
    selection = [id]
    await tween(800, (t) => {
      const s = Math.max(1, size * t)
      client.apply([{ k: 'set', id, props: { w: round(s), h: round(s * 0.8) } }])
      cursor = [at[0] + s, at[1] + s * 0.8]
      present()
    })
    await sleep(400)
    selection = []
    present()
  }

  async function recolor() {
    const id = created[Math.floor(Math.random() * created.length)]
    const node = views().find((v) => v.id === id)
    if (!node) return
    await glide([node.x + node.w / 2, node.y + node.h / 2])
    selection = [id]
    present()
    await sleep(300)
    client.apply([{ k: 'set', id, props: { fill: SWATCHES[4 + Math.floor(Math.random() * 6)] } }])
    await sleep(500)
    selection = []
    present()
  }

  async function run() {
    while (!stopped && client.getSnapshot().status !== 'online') await sleep(100)
    const box = unionBox(views()) ?? { x: 0, y: 0, w: 400, h: 300 }
    cursor = [box.x + box.w / 2, box.y + box.h / 2]
    while (!stopped) {
      const shapes = views().filter((v) => v.type !== 'text' && !created.includes(v.id))
      const roll = Math.random()
      if (roll < 0.45 && shapes.length) await nudgeShape(shapes[Math.floor(Math.random() * shapes.length)])
      else if (roll < 0.75 && created.length < 3) await drawShape()
      else if (created.length) await recolor()
      else await glide([cursor[0] + rand(-200, 200), cursor[1] + rand(-150, 150)], 1000)
      await sleep(rand(500, 1200))
    }
  }

  run()

  return () => {
    if (stopped) return
    stopped = true
    // Clean up after ourselves so the demo leaves the document as it found it.
    client.apply(created.map((id) => ({ k: 'del' as const, id })))
    client.dispose()
  }
}
