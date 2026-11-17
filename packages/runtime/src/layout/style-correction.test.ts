import { describe, expect, it } from 'vite-plus/test'
import {
  correctBoxShadows,
  correctCornerRadii,
  decodeBoxShadows,
  decodeCornerRadii,
} from './style-correction.ts'

const cornersText = ['10% 20%', '8px', 'calc(10% + 2px) 3px', '4px 7px']

describe('corner correction', () => {
  it('resolves elliptical percentages against the corresponding physical dimensions', () => {
    const corners = decodeCornerRadii(cornersText, 200, 100)

    expect(corners).toEqual([
      { x: 20, y: 20 },
      { x: 8, y: 8 },
      { x: 22, y: 3 },
      { x: 4, y: 7 },
    ])

    if (!corners) throw new Error('Expected decoded corners')

    expect(correctCornerRadii(corners, { x: 2, y: 0.5 })).toEqual([
      '10px 40px',
      '4px 16px',
      '11px 6px',
      '2px 14px',
    ])
    expect(correctCornerRadii(corners, { x: 1, y: 1 })?.[0]).toBe('20px 20px')
  })

  it('applies one CSS overlap-reduction factor to every corner', () => {
    expect(decodeCornerRadii(['80px 20px', '80px 20px', '20px', '20px'], 100, 50)).toEqual([
      { x: 50, y: 12.5 },
      { x: 50, y: 12.5 },
      { x: 12.5, y: 12.5 },
      { x: 12.5, y: 12.5 },
    ])
  })

  it.each([
    [[], 100, 100],
    [['1em', '0', '0', '0'], 100, 100],
    [['-2px', '0', '0', '0'], 100, 100],
    [['2px auto', '0', '0', '0'], 100, 100],
    [['2px -1px', '0', '0', '0'], 100, 100],
    [['1px 2px 3px', '0', '0', '0'], 100, 100],
    [['', '0', '0', '0'], 100, 100],
    [['0', '0', '0', '0'], -1, 100],
  ] as const)('rejects unsupported radius inputs: %j', (values, width, height) => {
    expect(decodeCornerRadii(values, width, height)).toBeUndefined()
  })

  it('handles zero-size overlap bases without an undefined ratio', () => {
    expect(decodeCornerRadii(['2px', '2px', '2px', '2px'], 0, 0)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
  })
})

describe('shadow correction', () => {
  it('retains nested color syntax and multiple inset/outset layers', () => {
    const shadows = decodeBoxShadows(
      'color-mix(in srgb, rgb(20, 30, 40) 50%, blue) 8px -4px 12px 2px, inset 3px 6px rgba(1, 2, 3, 0.5)',
    )

    expect(shadows).toEqual([
      {
        x: 8,
        y: -4,
        blur: 12,
        spread: 2,
        inset: false,
        color: 'color-mix(in srgb, rgb(20, 30, 40) 50%, blue)',
      },
      { x: 3, y: 6, blur: 0, spread: 0, inset: true, color: 'rgba(1, 2, 3, 0.5)' },
    ])

    if (!shadows) throw new Error('Expected decoded shadows')

    expect(correctBoxShadows(shadows, { x: 4, y: 1 })).toBe(
      '2px -4px 6px 1px color-mix(in srgb, rgb(20, 30, 40) 50%, blue), inset 0.75px 6px 0px 0px rgba(1, 2, 3, 0.5)',
    )
    expect(correctBoxShadows(shadows, { x: 1, y: 1 })).toContain('8px -4px 12px 2px')
  })

  it('uses the geometric mean for unequal-axis blur and negative spread', () => {
    const shadows = decodeBoxShadows('black 2px 3px 8px -4px')

    if (!shadows) throw new Error('Expected decoded shadows')

    expect(correctBoxShadows(shadows, { x: 4, y: 0.25 })).toBe('0.5px 12px 8px -4px black')
  })

  it('preserves absence of shadows', () => {
    expect(decodeBoxShadows('none')).toEqual([])
    expect(correctBoxShadows([], { x: 1, y: 2 })).toBe('none')
  })

  it.each([
    '',
    'black 1px',
    'black 1px 2px -3px',
    'black 1px 2px 3px 4px 5px',
    'black 1em 2px',
    'inset inset black 1px 2px',
    '1px 2px',
    'black blue 1px 2px',
    '1e999px 2px black',
  ])('rejects unsupported shadow: %s', (value) => {
    expect(decodeBoxShadows(value)).toBeUndefined()
  })

  it.each([
    { x: 0, y: 1 },
    { x: 1, y: -1 },
    { x: Infinity, y: 1 },
  ])('rejects collapsed/nonfinite scale: %j', (scale) => {
    const corners = decodeCornerRadii(['0', '0', '0', '0'], 100, 100)

    if (!corners) throw new Error('Expected decoded corners')

    expect(correctCornerRadii(corners, scale)).toBeUndefined()
    expect(correctBoxShadows([], scale)).toBeUndefined()
  })

  it('rejects unrepresentable corrected lengths despite finite inputs', () => {
    const corners = decodeCornerRadii(['2px', '2px', '2px', '2px'], 100, 100)
    const shadows = decodeBoxShadows('2px 3px 4px black')

    if (!corners || !shadows) throw new Error('Expected decoded styles')

    expect(correctCornerRadii(corners, { x: 1e-308, y: 1 })).toBeUndefined()
    expect(correctCornerRadii(corners, { x: 1, y: 1e-308 })).toBeUndefined()
    expect(correctBoxShadows(shadows, { x: 1e-308, y: 1 })).toBeUndefined()
  })
})

describe('affine style correction', () => {
  it('undoes shadow offset shear exactly and uses determinant area for radial lengths', () => {
    const matrix = { a: 2, b: 1, c: 1, d: 3, e: 100, f: -20 }
    const shadows = decodeBoxShadows('9px 7px 10px -5px black')

    if (!shadows) throw new Error('Expected decoded shadows')

    const output = correctBoxShadows(shadows, matrix)

    if (!output) throw new Error('Expected correction')

    const corrected = decodeBoxShadows(output)

    if (!corrected) throw new Error('Expected corrected shadows')

    expect(corrected[0].x).toBeCloseTo(4, 12)
    expect(corrected[0].y).toBeCloseTo(1, 12)
    expect(matrix.a * corrected[0].x + matrix.c * corrected[0].y).toBeCloseTo(9, 12)
    expect(matrix.b * corrected[0].x + matrix.d * corrected[0].y).toBeCloseTo(7, 12)
    expect(corrected[0].blur).toBeCloseTo(10 / Math.sqrt(5), 12)
    expect(corrected[0].spread).toBeCloseTo(-5 / Math.sqrt(5), 12)
  })

  it('uses local-axis magnitudes for the radius approximation under genuine shear', () => {
    const corners = decodeCornerRadii(['10px 20px', '0', '0', '0'], 100, 100)

    if (!corners) throw new Error('Expected decoded corners')

    expect(correctCornerRadii(corners, { a: 3, b: 4, c: 0, d: 2, e: 0, f: 0 })?.[0]).toBe(
      '2px 10px',
    )
  })

  it('rejects a singular affine correction', () => {
    expect(correctBoxShadows([], { a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toBeUndefined()
  })
})
