import { createContext, useContext } from 'react'
import type { SyncClient, SyncSnapshot } from '../sync/client'
import type { Op } from '../sync/protocol'
import type { Camera } from './geometry'
import type { History, Snapshot } from './history'
import type { NodeView, Tool } from './model'

export interface Editing {
  id: string
  snap: Snapshot
}

export interface EditorApi {
  client: SyncClient
  history: History
  snap: SyncSnapshot
  views: NodeView[]
  byId: Map<string, NodeView>
  selection: string[]
  setSelection(ids: string[]): void
  tool: Tool
  setTool(t: Tool): void
  camera: Camera
  setCamera(c: Camera | ((c: Camera) => Camera)): void
  editing: Editing | null
  startEditing(id: string, snap?: Snapshot): void
  finishEditing(): void
  hoverId: string | null
  setHoverId(id: string | null): void
  panMode: boolean
  /** Apply ops as one undoable step. */
  commit(ops: Op[]): void
  fit(): void
  jumpTo(x: number, y: number): void
  myColor: string
}

export const EditorContext = createContext<EditorApi | null>(null)

export function useEditor(): EditorApi {
  const ed = useContext(EditorContext)
  if (!ed) throw new Error('useEditor outside EditorContext')
  return ed
}
