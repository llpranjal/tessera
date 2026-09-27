// Fractional indexing: z-order keys that sort lexicographically, so moving a
// layer is a single property write on one node instead of renumbering siblings.
// Keys never end in '0', which guarantees there is always room between two keys.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

function digit(s: string, i: number): number {
  const d = DIGITS.indexOf(s[i])
  if (d < 0) throw new Error(`invalid index key: ${s}`)
  return d
}

/** A key strictly between `a` and `b`. `null` means unbounded on that side. */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? ''
  if (b !== null && lo >= b) throw new Error(`keyBetween: ${lo} >= ${b}`)
  let hi = b
  let out = ''
  for (let i = 0; ; i++) {
    const da = i < lo.length ? digit(lo, i) : 0
    const db = hi !== null ? (i < hi.length ? digit(hi, i) : 0) : BASE
    if (da === db) {
      out += DIGITS[da]
      continue
    }
    const mid = Math.floor((da + db) / 2)
    if (mid > da) return out + DIGITS[mid]
    // Adjacent digits: keep `lo`'s digit and look for room further right,
    // where the upper bound no longer constrains us.
    out += DIGITS[da]
    hi = null
  }
}

/** `n` evenly spread keys between `a` and `b`, in order. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [keyBetween(a, b)]
  const mid = keyBetween(a, b)
  const left = keysBetween(a, mid, Math.floor((n - 1) / 2))
  const right = keysBetween(mid, b, n - 1 - left.length)
  return [...left, mid, ...right]
}

/** Paint order comparator: by index key, then id to break concurrent ties. */
export function compareOrder(a: { id: string; index: string }, b: { id: string; index: string }): number {
  if (a.index !== b.index) return a.index < b.index ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
