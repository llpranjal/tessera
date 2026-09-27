import { initials } from '../lib/identity'

/** The mark: four tiles, one per collaborator color. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="logo">
      <rect x="1" y="1" width="10" height="10" rx="2.5" fill="#2B3BEA" />
      <circle cx="18" cy="6" r="5" fill="#F2A516" />
      <rect x="1" y="13" width="10" height="10" rx="2.5" fill="#12A383" />
      <rect x="13" y="13" width="10" height="10" rx="2.5" fill="#E8457A" />
    </svg>
  )
}

export function Avatar({ name, color, size = 28, ring }: { name: string; color: string; size?: number; ring?: boolean }) {
  return (
    <span
      className={`avatar${ring ? ' ring' : ''}`}
      style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}
      title={name}
    >
      {initials(name)}
    </span>
  )
}
