import { expect, test, type Page } from '@playwright/test'

type TransformCase = { name: string; styles: Record<string, string>; tolerance?: number }

const transforms: TransformCase[] = [
  ...[0, 90, 180, 270, -90, 360].map((angle) => ({
    name: `rotation ${angle}`,
    styles: { rotate: `${angle}deg` },
  })),
  { name: 'Y reflection', styles: { scale: '1 -1' } },
  { name: 'XY reflection', styles: { scale: '-1 -1' } },
  { name: 'X skew', styles: { transform: 'skewX(23deg)' } },
  { name: 'Y skew', styles: { transform: 'skewY(-17deg)' } },
  { name: 'affine matrix', styles: { transform: 'matrix(1.2, .3, -.2, .8, 15.25, -9.5)' } },
  { name: 'small invertible scale', styles: { transform: 'scale(.01)' }, tolerance: 1 },
  {
    name: 'all transform properties',
    styles: {
      translate: '-13.5px 35%',
      rotate: '-110deg',
      scale: '-.8 -1.2',
      transform: 'translate(7px, 11px) rotate(27deg) skew(12deg, -8deg)',
    },
  },
  ...['0px 0px', '100% 100%', '-15.25px 120%'].map((origin) => ({
    name: `pivot ${origin}`,
    styles: { 'transform-origin': origin, rotate: '37deg', scale: '.7 1.3' },
  })),
  ...['border-box', 'view-box', 'content-box', 'fill-box'].map((box) => ({
    name: `reference ${box}`,
    styles: { 'transform-box': box, translate: '50% 25%' },
  })),
]

async function readTransformedFixture(page: Page, styles: Record<string, string>) {
  await page.goto('/tests/browser/')

  return page.evaluate(async (appliedStyles) => {
    const { readLayoutBounds } = await import('../../packages/runtime/src/layout-bounds.ts')
    const root = document.createElement('div')
    root.style.cssText =
      'position:relative;box-sizing:border-box;width:320.5px;height:240.25px;border:3px solid;padding:16.5px;'
    const target = document.createElement('div')
    target.style.cssText =
      'box-sizing:border-box;width:120.25px;height:35.5px;border:2px solid;padding:3px 5px 9px 15px;'
    root.append(target)
    document.body.append(root)

    try {
      // Apply the transform to the target and its ancestor independently. Root
      // positioning establishes the containing block before any transform is set.
      const samples = []

      for (const element of [target, root]) {
        for (const [name, value] of Object.entries(appliedStyles)) {
          if (!CSS.supports(name, value))
            throw new Error(`Unsupported test style: ${name}: ${value}`)

          element.style.setProperty(name, value)
        }
        const css = root.outerHTML
        const reasons: string[] = []

        samples.push({
          ancestor: element === root,
          bounds: readLayoutBounds(target, root, (reason) => reasons.push(reason)),
          reasons,
          preserved: css === root.outerHTML,
        })

        for (const name of Object.keys(appliedStyles)) element.style.removeProperty(name)
      }

      return samples
    } finally {
      root.remove()
    }
  }, styles)
}

for (const transformCase of transforms) {
  test(`layout bounds preserve fractional placement under ${transformCase.name}`, async ({
    page,
  }) => {
    const samples = await readTransformedFixture(page, transformCase.styles)
    // A 0.01 ancestor scale amplifies viewport quantization by 100 on inversion.
    // Ordinary transforms retain a quarter-pixel tolerance, including WebKit's
    // observed quarter-pixel rounding at exact half-turns and double reflections.
    for (const { bounds, reasons, preserved, ancestor } of samples) {
      const tolerance = ancestor ? (transformCase.tolerance ?? 0.25) : 0.25

      expect(Math.abs(bounds.x - 16.5)).toBeLessThanOrEqual(tolerance)
      expect(Math.abs(bounds.y - 16.5)).toBeLessThanOrEqual(tolerance)
      expect(bounds).toMatchObject({ width: 120.25, height: 35.5, attached: true })
      expect(reasons).toEqual([])
      expect(preserved).toBe(true)
    }
  })
}

const unsupportedTransforms: (TransformCase & { reason: string })[] = [
  ...['0px 0px', '20% 80%', '10px 15px'].map((origin) => ({
    name: `content-box pivot ${origin}`,
    styles: { 'transform-box': 'content-box', 'transform-origin': origin, rotate: '30deg' },
    reason: 'content-box transform origins',
  })),
  {
    name: 'fill-box scaling',
    styles: { 'transform-box': 'fill-box', scale: '2 .5' },
    reason: 'content-box transform origins',
  },
  {
    name: 'stroke-box percentage translation',
    styles: { 'transform-box': 'stroke-box', translate: '50% 25%' },
    reason: 'stroke-box transforms',
  },
  {
    name: 'unresolved calc translation',
    styles: { translate: 'calc(50% + 10px) 0px' },
    reason: 'two-dimensional numeric transforms',
  },
  ...['matrix(1, 2, 2, 4, 0, 0)', 'scaleX(0)', 'scaleY(0)', 'scale(.000001)'].map((transform) => ({
    name: `singular ${transform}`,
    styles: { transform },
    reason: 'singular transform',
  })),
]

for (const transformCase of unsupportedTransforms) {
  test(`layout bounds diagnose ${transformCase.name} without publishing invalid positions`, async ({
    page,
  }) => {
    const samples = await readTransformedFixture(page, transformCase.styles)

    for (const { bounds, reasons, preserved } of samples) {
      expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0, attached: false })
      expect(reasons).toEqual([expect.stringContaining(transformCase.reason)])
      expect(preserved).toBe(true)
    }
  })
}
