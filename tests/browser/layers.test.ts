import { expect, test } from '@playwright/test'

const base = 'http://127.0.0.1:4180'

test('overlapping button layers compose hover, focus, and pointer or keyboard press', async ({
  page,
}) => {
  await page.goto(`${base}/interactive-button`)
  const button = page.getByTestId('interactive-button')

  await button.focus()
  await button.hover()

  await expect(button).toHaveCSS('scale', '1.08')

  await page.keyboard.down('Space')

  await expect(button).toHaveCSS('scale', '0.94')
  await expect(button).toHaveCSS('box-shadow', 'rgb(22, 121, 91) 0px 0px 0px 4px')

  await page.keyboard.up('Space')

  await expect(button).toHaveCSS('scale', '1.08')

  await page.mouse.down()

  await expect(button).toHaveCSS('scale', '0.94')

  await page.mouse.up()

  await expect(button).toHaveCSS('scale', '1.08')

  await page.mouse.move(0, 0)

  await expect(button).toHaveCSS('scale', '1')
})

test('toggle directional animation retargets from its displayed midpoint', async ({ page }) => {
  await page.goto(`${base}/toggle`)
  const button = page.getByRole('switch', { name: 'Notifications', exact: true })
  const thumb = button.locator('span')

  await button.click()
  await thumb.evaluate((element) => {
    for (const animation of element.getAnimations()) {
      animation.pause()
      animation.currentTime = 50
    }
  })

  const before = await thumb.evaluate((element) => getComputedStyle(element).translate)

  await button.click()
  const start = await thumb.evaluate((element) => {
    const animation = element
      .getAnimations()
      .find(
        (item) =>
          item.effect instanceof KeyframeEffect &&
          item.effect.getKeyframes()[0].translate !== undefined,
      )

    return animation?.effect instanceof KeyframeEffect
      ? animation.effect.getKeyframes()[0].translate
      : undefined
  })

  expect(start).toBe(before)

  await expect(thumb).toHaveCSS('translate', '0px')
})

test('async submit advances its local machine while Vue owns completion', async ({ page }) => {
  await page.goto(`${base}/async-submit`)
  const button = page.getByTestId('submit')

  await button.click()

  await expect(button).toBeDisabled()
  await expect(page.getByRole('status')).toHaveText('Saving…')
  await expect(page.getByRole('status')).toHaveText('Saved')
  await expect(button).toBeEnabled()
  await expect(button).toHaveCSS('background-color', 'rgb(100, 198, 158)')
  await expect(button).toHaveCSS('scale', '1')

  await button.click()

  await expect(button).toBeDisabled()
})

test('layer timeline shows its editing limitation without replacing application presentation', async ({
  page,
}) => {
  await page.goto(`${base}/toggle`)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()

  await expect(page.getByRole('status')).toContainText('read-only')
  await expect(page.getByLabel('Playhead')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save to source' })).toHaveCount(0)

  const button = page.getByRole('switch', { name: 'Notifications', exact: true })

  await button.click()

  await expect(button).toHaveAttribute('aria-checked', 'true')
  await expect(button).toHaveCSS('background-color', 'rgb(52, 178, 123)')
})
