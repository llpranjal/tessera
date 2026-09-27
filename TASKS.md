# Tessera — build checklist

Finish line: Rust server + React/TS client working end-to-end in a browser with two
live collaborators, Rust + TS test suites green, production build served by the
single Rust binary, recruiter-ready README with screenshots.

## Server (Rust)
- [x] Axum app: REST (`/api/docs` CRUD, `/api/stats`, thumbnails) + WebSocket `/ws/:doc`
- [x] Room model: authoritative doc, per-peer ordered outbound queue, backpressure
- [x] Op application (create / set / del) with validation limits
- [x] SQLite persistence (dirty-flag flush loop + flush on last leave)
- [x] Server-rendered SVG thumbnails
- [x] Serve built SPA from `web/dist` with fallback
- [x] Unit tests (doc semantics, thumbnails) + WebSocket integration test

## Client (React + TypeScript)
- [x] Sync engine: optimistic ops, pending-key suppression, acks, batching, reconnect replay
- [x] Fractional indexing for z-order
- [x] Canvas: pan/zoom, select / marquee, move, resize, rect / ellipse / text / pen tools
- [x] Layers panel, properties panel, toolbar, keyboard shortcuts
- [x] Undo / redo (local, inverse ops), duplicate, copy/paste, reorder
- [x] Presence: live cursors, remote selections, avatar stack, jump-to-peer
- [x] Dashboard: file grid with thumbnails, live editor counts, create/rename/delete
- [x] Vitest: sync engine, fractional index, geometry

## Ship
- [x] Demo bot (second real WebSocket client) for solo demos
- [x] Graceful shutdown on SIGINT/SIGTERM flushes open docs
- [x] End-to-end check in browser with two tabs (edits, cursors, text, undo, offline replay, demo bot)
- [x] Dockerfile (multi-stage, single binary) — written, not built locally (no Docker on this machine)
- [x] README: architecture, protocol, benchmarks, tests
- [x] Load benchmark (`bench/load.mjs`) + CI workflow
- [ ] Add a screenshot/GIF to the README
- [ ] Push to GitHub (github.com/llpranjal/tessera is linked from the app footer) and deploy
