import { describe, expect, it } from 'vitest'
import { compareOrder, keyBetween, keysBetween } from './fractional'

describe('keyBetween', () => {
  it('produces keys strictly between the bounds', () => {
    const cases: [string | null, string | null][] = [
      [null, null],
      [null, 'a1'],
      ['a1', null],
      ['a1', 'a2'],
      ['U', 'U1'],
      ['U', 'U01'],
      ['U5', 'V'],
      ['', '1'],
      ['z', null],
    ]
    for (const [a, b] of cases) {
      const k = keyBetween(a, b)
      if (a !== null) expect(k > a, `${k} > ${a}`).toBe(true)
      if (b !== null) expect(k < b, `${k} < ${b}`).toBe(true)
      expect(k.endsWith('0')).toBe(false)
    }
  })

  it('survives repeated insertion at the same spot', () => {
    let lo = 'a1'
    const hi = 'a2'
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi)
      expect(k > lo && k < hi).toBe(true)
      lo = k
    }
    let top: string | null = null
    const keys: string[] = []
    for (let i = 0; i < 200; i++) {
      top = keyBetween(top, null)
      keys.push(top)
    }
    expect([...keys].sort()).toEqual(keys)
  })

  it('rejects inverted bounds', () => {
    expect(() => keyBetween('b', 'a')).toThrow()
  })
})

describe('keysBetween', () => {
  it('returns n ordered keys inside the range', () => {
    const keys = keysBetween('a1', 'a2', 7)
    expect(keys).toHaveLength(7)
    expect([...keys].sort()).toEqual(keys)
    expect(keys.every((k) => k > 'a1' && k < 'a2')).toBe(true)
  })
})

describe('compareOrder', () => {
  it('breaks index ties by id', () => {
    const items = [
      { id: 'b', index: 'a1' },
      { id: 'a', index: 'a1' },
      { id: 'c', index: 'a0V' },
    ]
    expect(items.sort(compareOrder).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })
})
