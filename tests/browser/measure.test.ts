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
    if (!(animation?.effect instanceof KeyframeEffect))
      throw new Error('Expected collapse animation')

    return parseFloat(String(animation.effect.getKeyframes()[0].blockSize))
  })
  expect(start).toBeCloseTo(midpoint, 1)
  await expect(shell).toHaveCSS('block-size', '0px')
  await expect(inner).toContainText('Changing content or viewport width')
  await expect(explanation).toHaveCount(0)
})
