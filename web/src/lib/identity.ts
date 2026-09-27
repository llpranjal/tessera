const KEY = 'tessera.name'

const ADJECTIVES = ['Amber', 'Brisk', 'Cobalt', 'Dapper', 'Eager', 'Fern', 'Gentle', 'Hazel', 'Indigo', 'Jolly', 'Keen', 'Lunar', 'Mellow', 'Nimble', 'Opal', 'Plucky', 'Quiet', 'Rosy', 'Sunny', 'Tidy', 'Velvet', 'Witty']
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Marten', 'Finch', 'Badger', 'Koi', 'Puffin', 'Ibex', 'Wren', 'Gecko', 'Tapir', 'Moth', 'Quokka', 'Seal', 'Vole']

const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)]

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let cached: string | null = null

export function getName(): string {
  if (!cached) {
    const stored = read()
    if (stored) cached = stored
    else setName(`${pick(ADJECTIVES)} ${pick(ANIMALS)}`)
  }
  return cached!
}

export function setName(name: string) {
  cached = name.trim().slice(0, 40) || getName()
  try {
    localStorage.setItem(KEY, cached)
  } catch {
    // Private mode: keep the name for this tab only.
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}
