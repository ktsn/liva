import { expect, test } from '@playwright/test'

const base = 'http://127.0.0.1:4180'

test('measured tabs initialize without animation and follow unequal responsive labels', async ({
  page,
}) => {
  await page.goto(`${base}/layout-bounds`)
  const indicator = page.locator('.measured-indicator')
  const tabs = page.getByRole('group', { name: 'View' })
  const first = tabs.getByRole('button', { name: 'Overview', exact: true })
  const second = tabs.getByRole('button', { name: 'Activity and updates', exact: true })

  await expect(indicator).toBeVisible()
  const initial = await indicator.boundingBox()
  const selected = await first.boundingBox()
  expect(initial?.width).toBeCloseTo(selected?.width ?? 0, 1)
  expect(await indicator.evaluate((element) => element.getAnimations().length)).toBe(0)

  await second.click()

  await expect(second).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await indicator.boundingBox())?.width)
    .toBeCloseTo((await second.boundingBox())?.width ?? 0, 1)

  await page.setViewportSize({ width: 600, height: 800 })

  await expect
    .poll(async () => {
      const box = await indicator.boundingBox()
      const button = await second.boundingBox()

      return (
        Math.abs((box?.x ?? 0) - (button?.x ?? 0)) +
        Math.abs((box?.width ?? 0) - (button?.width ?? 0))
      )
    })
    .toBeLessThan(0.2)
})

test('natural inner content updates expansion and interrupted collapse begins at the displayed height', async ({
  page,
}) => {
  await page.goto(`${base}/layout-bounds`)
  const shell = page.locator('.measured-shell')
  const inner = page.locator('.measured-inner')
  const toggle = page.getByRole('button', { name: 'Expand details', exact: true })
  const explanation = page.getByRole('paragraph').filter({ hasText: 'The shell follows' })

  await expect(shell).toHaveCSS('block-size', '0px')
  await expect(explanation).toHaveCount(0)

  await toggle.click()

  await expect(explanation).toHaveCount(1)

  await expect
    .poll(async () => (await shell.boundingBox())?.height)
    .toBeCloseTo((await inner.boundingBox())?.height ?? 0, 1)

  await page.getByRole('button', { name: 'More content', exact: true }).click()

  await expect
    .poll(() => shell.evaluate((element) => element.getAnimations().length))
    .toBeGreaterThan(0)

  const midpoint = await shell.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Expected content resize animation')

    animation.pause()
    animation.currentTime = 150

    return parseFloat(getComputedStyle(element).blockSize)
  })

  await page.getByRole('button', { name: 'Collapse details', exact: true }).click()

  const start = await shell.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Expected collapse animation')

    // Compare rendered heights so logical/physical property normalization does not
    // affect the continuity check at the start of the interrupted transition.
    animation.pause()
    animation.currentTime = 0
    const height = parseFloat(getComputedStyle(element).blockSize)
    animation.play()

    return height
  })
  expect(start).toBeCloseTo(midpoint, 1)
  await expect(shell).toHaveCSS('block-size', '0px')
  await expect(inner).toContainText('Changing content or viewport width')
  await expect(explanation).toHaveCount(0)
})

for (const intermediaryPosition of ['static', 'relative'] as const) {
  test(`fractional bounds survive affine transforms and scrolling through a ${intermediaryPosition} ancestor`, async ({
    page,
  }) => {
    await page.goto('/tests/browser/')
    const result = await page.evaluate(async (position) => {
      const { readLayoutBounds } = await import('../../packages/runtime/src/layout-bounds.ts')

      const root = document.createElement('div')
      root.style.cssText =
        'position:relative;box-sizing:border-box;width:320.5px;height:240.25px;border:3px solid;padding:16.5px;overflow:auto;'
      const middle = document.createElement('div')
      middle.style.cssText = `position:${position};width:180.25px;height:120.5px;padding:7.25px;border:1px solid;overflow:auto;`
      const target = document.createElement('div')
      target.style.cssText =
        'position:absolute;box-sizing:border-box;left:60.25px;top:40.5px;width:120.25px;height:35.5px;'
      const spacer = document.createElement('div')
      spacer.style.cssText = 'width:800px;height:800px;'
      middle.append(target, spacer)
      root.append(middle)
      document.body.append(root)

      try {
        const references = [root, middle, target]
        const before = references.map((reference) => readLayoutBounds(target, reference))

        root.style.transform = 'translate(13.25px, -4.5px) rotate(23deg) scale(-.7, 1.3)'

        if (position === 'relative') middle.style.transform = 'rotate(-11deg) scale(1.1, .9)'

        target.style.translate = '50% 4.25px'
        target.style.transform = 'skew(12deg, -7deg) scale(-.7, 1.1)'
        target.style.transformOrigin = '-15.25px 120%'
        root.scrollTop = 30
        middle.scrollTop = 40
        middle.scrollLeft = 20

        const authoredStyles = root.outerHTML

        const after = references.map((reference) => readLayoutBounds(target, reference))

        return { before, after, preservedStyles: root.outerHTML === authoredStyles }
      } finally {
        root.remove()
      }
    }, intermediaryPosition)

    for (const [index, bounds] of result.after.entries()) {
      const baseline = result.before[index]

      // Fractional results remain useful despite engine-specific transform serialization precision.
      expect(Math.abs(bounds.x - baseline.x)).toBeLessThan(0.25)
      expect(Math.abs(bounds.y - baseline.y)).toBeLessThan(0.25)
      expect(bounds).toMatchObject({ width: 120.25, height: 35.5, attached: true })
    }

    expect(result.after[2]).toMatchObject({ x: 0, y: 0 })
    expect(result.preservedStyles).toBe(true)
  })
}
