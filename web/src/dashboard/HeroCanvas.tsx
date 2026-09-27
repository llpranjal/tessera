// A small illustration of the product: two collaborators in one file, one of
// them dragging a shape. Pure CSS animation, paused for reduced motion.
// Everything lives in one SVG so shapes and cursors scale together.

function Cursor({ x, y, name, color, className }: { x: number; y: number; name: string; color: string; className?: string }) {
  const w = name.length * 7.4 + 16
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={className}>
        <path d="M1.5 1.5 L16 10.2 L9.4 11.6 L6.3 18 Z" fill={color} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="13" y="18" width={w} height="22" rx="6" fill={color} />
        <text x={13 + w / 2} y="33" textAnchor="middle" className="hero-cursor-text">{name}</text>
      </g>
    </g>
  )
}

export function HeroCanvas() {
  return (
    <div className="hero-canvas" aria-hidden>
      <svg viewBox="0 0 440 320" className="hero-shapes">
        <rect x="36" y="40" width="170" height="112" rx="16" fill="#2B3BEA" />
        <rect x="36" y="172" width="120" height="14" rx="7" fill="#161A23" />
        <rect x="36" y="196" width="170" height="10" rx="5" fill="#C3C8D4" />
        <rect x="36" y="214" width="140" height="10" rx="5" fill="#C3C8D4" />
        <rect x="246" y="196" width="150" height="92" rx="16" fill="#12A383" />
        <rect x="243" y="193" width="156" height="98" rx="18" fill="none" stroke="#E8457A" strokeWidth="2" />
        <g className="hero-drag">
          <circle cx="300" cy="96" r="44" fill="#F2A516" />
          <rect x="256" y="52" width="88" height="88" fill="none" stroke="#2B3BEA" strokeWidth="2" />
          {[[256, 52], [344, 52], [256, 140], [344, 140]].map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x - 4} y={y - 4} width="8" height="8" rx="1.5" fill="#fff" stroke="#2B3BEA" strokeWidth="2" />
          ))}
          <Cursor x={316} y={104} name="Maya" color="#2B3BEA" />
        </g>
        <Cursor x={336} y={262} name="Linus" color="#E8457A" className="hero-idle" />
      </svg>
    </div>
  )
}
