import { describe, expect, it } from 'vite-plus/test'
import { components, numeric } from './computed-value.ts'

describe('computed numeric components', () => {
  it('keeps nested math/color functions intact while ignoring repeated whitespace', () => {
    expect(components('  calc(20% + min(4px, 8px))   rgb(2, 3, 4)  ')).toEqual([
      'calc(20% + min(4px, 8px))',
      'rgb(2, 3, 4)',
    ])
  })

  it.each([
    ['calc(20% + min(20px, 15px))', 200, 55],
    ['calc(2 * (3px + 4px))', 0, 14],
    ['clamp(5px, 50%, 20px)', 100, 20],
    ['-2.5px', 0, -2.5],
    ['50%', 1, 0.5],
  ] as const)('resolves %s in its supplied numeric basis', (value, reference, expected) => {
    expect(numeric(value, reference)).toBe(expected)
  })

  it.each(['', '10px@', 'auto', '1em', '1e999px'])(
    'rejects unsupported/nonfinite computed text: %s',
    (value) => {
      expect(numeric(value, 200)).toBeUndefined()
    },
  )
})
