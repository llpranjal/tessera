// Wire protocol. Mirrors `server/src/protocol.rs` and `server/src/doc.rs`.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Props = Record<string, Json>

export type Op =
  | { k: 'create'; id: string; props: Props }
  | { k: 'set'; id: string; props: Props }
  | { k: 'del'; id: string }

export type Cursor = [number, number] | null

export interface PeerInfo {
  sid: number
  name: string
  color: string
  cursor: Cursor
  selection: string[]
}

export type ClientMsg =
  | { t: 'ops'; seq: number; ops: Op[] }
  | { t: 'presence'; cursor: Cursor; selection: string[] }

export type ServerMsg =
  | {
      t: 'welcome'
      you: PeerInfo
      doc: { id: string; name: string }
      version: number
      nodes: Record<string, Props>
      peers: PeerInfo[]
    }
  | { t: 'ops'; from: number; version: number; ops: Op[] }
  | { t: 'ack'; seq: number; version: number }
  | { t: 'reject'; seq: number; message: string }
  | { t: 'snapshot'; version: number; nodes: Record<string, Props> }
  | { t: 'presence'; sid: number; cursor: Cursor; selection: string[] }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; sid: number }
  | { t: 'meta'; name: string }
  | { t: 'deleted' }
