import { describe, expect, it } from 'vite-plus/test'
import {
  correctBoxShadows,
  correctCornerRadii,
  decodeBoxShadows,
  decodeCornerRadii,
} from './style-correction.ts'

const cornerProperties = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
]

function readCorners(element: HTMLElement) {
  const style = getComputedStyle(element)

  return decodeCornerRadii(
    cornerProperties.map((property) => style.getPropertyValue(property)),
    200,
    100,
  )
}

describe('computed style correction', () => {
  it('decodes and reencodes actual elliptical percentage radii and modern-color shadows', () => {
    const target = document.createElement('div')
    target.style.cssText =
      'box-sizing: border-box; width: 200px; height: 100px; border-radius: 10% 12px 8px 4px / 20% 8px 4px 2px; box-shadow: color-mix(in srgb, rgb(20, 30, 40) 50%, blue) 8px -4px 12px 2px, inset 3px 6px rgba(1, 2, 3, .5)'
    document.body.append(target)

    try {
      const corners = readCorners(target)
      const shadows = decodeBoxShadows(getComputedStyle(target).boxShadow)

      expect(corners?.[0]).toEqual({ x: 20, y: 20 })
      expect(
        shadows?.map(({ x, y, blur, spread, inset }) => ({ x, y, blur, spread, inset })),
      ).toEqual([
        { x: 8, y: -4, blur: 12, spread: 2, inset: false },
        { x: 3, y: 6, blur: 0, spread: 0, inset: true },
      ])

      if (!corners || !shadows) throw new Error('Expected supported browser serialization')

      const corrected = correctCornerRadii(corners, { x: 2, y: 0.5 })
      const correctedShadows = correctBoxShadows(shadows, { x: 2, y: 0.5 })

      if (!corrected || !correctedShadows) throw new Error('Expected correction')

      cornerProperties.forEach((property, index) =>
        target.style.setProperty(property, corrected[index]),
      )
      target.style.boxShadow = correctedShadows

      expect(readCorners(target)?.[0]).toEqual({ x: 10, y: 40 })
      expect(decodeBoxShadows(getComputedStyle(target).boxShadow)?.[0]).toMatchObject({
        x: 4,
        y: -8,
        blur: 12,
        spread: 2,
      })
    } finally {
      target.remove()
    }
  })

  it('accepts fresh uncorrected animated CSS snapshots without accumulating previous correction', () => {
    const target = document.createElement('div')
    target.style.cssText = 'width: 200px; height: 100px'
    document.body.append(target)
    const animation = target.animate(
      [
        { borderRadius: '8px 12px', boxShadow: 'black 4px 8px 10px 2px' },
        { borderRadius: '24px 28px', boxShadow: 'black 12px 16px 18px 6px' },
      ],
      { duration: 1000, fill: 'both' },
    )
    animation.pause()

    try {
      for (const time of [250, 500, 250]) {
        animation.currentTime = time

        const corners = readCorners(target)
        const shadows = decodeBoxShadows(getComputedStyle(target).boxShadow)

        if (!corners || !shadows) throw new Error('Expected animated computed styles')

        const correctedCorners = correctCornerRadii(corners, { x: 2, y: 0.5 })
        const correctedShadows = correctBoxShadows(shadows, { x: 2, y: 0.5 })
        const radius = 8 + (16 * time) / 1000

        expect(correctedCorners?.[0]).toBe(`${radius / 2}px ${radius * 2}px`)
        expect(correctedShadows).toContain(
          `${(4 + (8 * time) / 1000) / 2}px ${(8 + (8 * time) / 1000) * 2}px`,
        )
      }
    } finally {
      animation.cancel()
      target.remove()
    }
  })
  it.each([
    ['DOMMatrix', DOMMatrix],
    ['DOMMatrixReadOnly', DOMMatrixReadOnly],
  ] as const)('accepts native %s coefficients exposed through prototype getters', (_, Matrix) => {
    const corners = decodeCornerRadii(['10px 20px', '0', '0', '0'], 200, 100)
    const shadows = decodeBoxShadows('9px 7px 10px -5px black')
    const radiusMatrix = new Matrix([3, 4, 0, 2, 80, -20])
    const shadowMatrix = new Matrix([2, 1, 1, 3, 100, -20])

    if (!corners || !shadows) throw new Error('Expected decoded baseline styles')

    expect(correctCornerRadii(corners, radiusMatrix)?.[0]).toBe('2px 10px')

    const output = correctBoxShadows(shadows, shadowMatrix)

    if (!output) throw new Error('Expected native matrix shadow correction')

    const corrected = decodeBoxShadows(output)

    if (!corrected) throw new Error('Expected corrected shadows')

    expect(corrected[0].x).toBeCloseTo(4, 12)
    expect(corrected[0].y).toBeCloseTo(1, 12)
    expect(corrected[0].blur).toBeCloseTo(10 / Math.sqrt(5), 12)
    expect(corrected[0].spread).toBeCloseTo(-5 / Math.sqrt(5), 12)
  })
})
