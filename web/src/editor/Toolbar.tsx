import { Circle, Hand, MousePointer2, PenLine, Square, Type } from 'lucide-react'
import type { ComponentType } from 'react'
import { useEditor } from './context'
import type { Tool } from './model'

const TOOLS: { tool: Tool; label: string; key: string; Icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { tool: 'select', label: 'Move', key: 'V', Icon: MousePointer2 },
  { tool: 'hand', label: 'Hand', key: 'H', Icon: Hand },
  { tool: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  { tool: 'text', label: 'Text', key: 'T', Icon: Type },
  { tool: 'path', label: 'Pen', key: 'P', Icon: PenLine },
]

export function Toolbar() {
  const { tool, setTool } = useEditor()
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      {TOOLS.map(({ tool: t, label, key, Icon }, i) => (
        <button
          key={t}
          className={`tool${tool === t ? ' active' : ''}${i === 2 ? ' gap' : ''}`}
          onClick={() => setTool(t)}
          aria-pressed={tool === t}
          aria-label={`${label} (${key})`}
          data-tip={`${label}  ${key}`}
        >
          <Icon size={18} strokeWidth={1.75} />
        </button>
      ))}
    </div>
  )
}
