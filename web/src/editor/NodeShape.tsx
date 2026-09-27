import { memo, useEffect, useRef } from 'react'
import { smoothPath } from './geometry'
import type { NodeView } from './model'

export const TEXT_LINE_HEIGHT = 1.25

function pathD(n: NodeView): string {
  return smoothPath(n.points.map(([px, py]) => [n.x + px * n.w, n.y + py * n.h]))
}

export const NodeShape = memo(function NodeShape({ node: n, hidden }: { node: NodeView; hidden?: boolean }) {
  const common = {
    'data-node-id': n.id,
    opacity: hidden ? 0 : n.opacity,
    stroke: n.stroke ?? undefined,
    strokeWidth: n.stroke ? n.strokeWidth : undefined,
  }
  switch (n.type) {
    case 'ellipse':
      return <ellipse {...common} cx={n.x + n.w / 2} cy={n.y + n.h / 2} rx={n.w / 2} ry={n.h / 2} fill={n.fill} />
    case 'path': {
      const d = pathD(n)
      return (
        <g data-node-id={n.id} opacity={hidden ? 0 : n.opacity}>
          {/* Wide invisible stroke so thin lines are easy to grab. */}
          <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(14, n.strokeWidth + 10)} strokeLinecap="round" />
          <path d={d} fill="none" stroke={n.stroke ?? '#161A23'} strokeWidth={n.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    }
    case 'text':
      return (
        <foreignObject data-node-id={n.id} x={n.x} y={n.y} width={n.w} height={Math.max(n.h, n.fontSize * TEXT_LINE_HEIGHT)} opacity={hidden ? 0 : n.opacity} overflow="visible">
          <div className="text-node" style={{ fontSize: n.fontSize, fontWeight: n.fontWeight, color: n.fill, lineHeight: TEXT_LINE_HEIGHT }}>
            {n.text || ' '}
          </div>
        </foreignObject>
      )
    default: {
      const r = Math.min(n.radius, n.w / 2, n.h / 2)
      return <rect {...common} x={n.x} y={n.y} width={n.w} height={n.h} rx={r} ry={r} fill={n.fill} />
    }
  }
})

/** In-place text editor. Keystrokes are streamed to collaborators as you type. */
export function TextEditor({
  node,
  onInput,
  onDone,
}: {
  node: NodeView
  onInput: (text: string, height: number) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current!
    el.innerText = node.text
    // Focus on the next frame: the mousedown that created this editor would
    // otherwise move focus back to the page and blur it immediately.
    const raf = requestAnimationFrame(() => {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
    return () => cancelAnimationFrame(raf)
    // Only on mount: after that the DOM is the source of truth while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <foreignObject x={node.x} y={node.y} width={node.w} height={Math.max(node.h, node.fontSize * TEXT_LINE_HEIGHT) + 4} overflow="visible">
      <div
        ref={ref}
        className="text-node editing"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        style={{ fontSize: node.fontSize, fontWeight: node.fontWeight, color: node.fill, lineHeight: TEXT_LINE_HEIGHT }}
        onInput={(e) => onInput(e.currentTarget.innerText.replace(/\n$/, ''), e.currentTarget.offsetHeight)}
        onBlur={onDone}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault()
            ref.current?.blur()
          }
        }}
      />
    </foreignObject>
  )
}
