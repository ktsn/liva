import { describe, expect, it } from 'vite-plus/test'
import { correctLayoutStyles } from './layout-style-baseline.ts'
import type { CornerRadii } from '../layout/style-correction.ts'

const distortion = { a: 0.5, b: 0, c: 0, d: 0.25, e: 0, f: 0 }
const radii: CornerRadii = [
  { x: 2, y: 3 },
  { x: 4, y: 5 },
  { x: 6, y: 7 },
  { x: 8, y: 9 },
]

describe('layout paint fallback', () => {
  it('keeps decoded corner correction when the shadow decoder supplies no representation', () => {
    const values = correctLayoutStyles({ radii }, distortion)

    expect(values.get('border-top-left-radius')).toBe('4px 12px')
    expect(values.get('border-bottom-left-radius')).toBe('16px 36px')
    expect(values.has('box-shadow')).toBe(false)
  })

  it('leaves failed correction groups at source CSS when an inverse cannot be represented', () => {
    const values = correctLayoutStyles(
      { radii, shadows: [] },
      { a: 1e-320, b: 0, c: 0, d: 1, e: 0, f: 0 },
    )

    expect(values.size).toBe(0)
  })
})
