import { expect, test, type Locator } from '@playwright/test'

const base = 'http://127.0.0.1:4180'

async function expectBrowserScale(button: Locator) {
  const expected = await button.evaluate((element) =>
    element.matches(':disabled')
      ? '1'
      : element.matches(':active')
        ? '0.94'
        : element.matches(':hover')
          ? '1.08'
          : '1',
  )

  await expect(button).toHaveCSS('scale', expected)
}

test.describe('interactive button', () => {
  test('composes selected color with browser hover and active scale', async ({ page }) => {
    await page.goto(`${base}/interactive-button`)

    const button = page.getByTestId('interactive-button')

    await button.click()

    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveCSS('background-color', 'rgb(100, 198, 158)')
    await expectBrowserScale(button)

    await page.mouse.down()

    await expectBrowserScale(button)
    await expect(button).toHaveCSS('background-color', 'rgb(100, 198, 158)')

    await page.mouse.move(0, 0)
    await page.mouse.up()

    await expectBrowserScale(button)
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveCSS('background-color', 'rgb(100, 198, 158)')
  })

  for (const key of ['Space', 'Enter']) {
    test(`uses native ${key} activation and browser active matching`, async ({ page }) => {
      await page.goto(`${base}/interactive-button`)

      const button = page.getByTestId('interactive-button')

      await button.focus()
      await page.keyboard.down(key)

      await expectBrowserScale(button)
      expect(await button.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
      await expect(button).toHaveCSS('box-shadow', 'rgb(22, 121, 91) 0px 0px 0px 4px')

      await page.keyboard.up(key)

      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expectBrowserScale(button)
    })
  }

  test('suppresses disabled activation and keeps selection when re-enabled', async ({ page }) => {
    await page.goto(`${base}/interactive-button`)

    const button = page.getByTestId('interactive-button')
    const disabled = page.getByRole('checkbox', { name: 'Disable button' })

    await button.click()
    await disabled.check()

    await expect(button).toBeDisabled()

    await button.hover({ force: true })
    await page.mouse.down()
    await page.mouse.up()
    await button.evaluate((element) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Unexpected control element')

      element.click()
    })
    await button.focus()

    await expect(button).not.toBeFocused()

    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveCSS('scale', '1')
    await expect(button).toHaveCSS('background-color', 'rgb(211, 216, 213)')

    await disabled.uncheck()

    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveCSS('background-color', 'rgb(100, 198, 158)')

    await button.focus()
    await page.keyboard.press('Space')

    await expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  test('clears an active press when disabled and settles interrupted animations', async ({
    page,
  }) => {
    await page.goto(`${base}/interactive-button`)

    const button = page.getByTestId('interactive-button')
    const disabled = page.getByRole('checkbox', { name: 'Disable button' })

    await button.hover()
    await page.mouse.down()

    await expectBrowserScale(button)

    // Toggle the separate native control while the pointer is still held on the button.
    await disabled.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('Unexpected control element')

      element.click()
    })

    await expect(button).toBeDisabled()
    await expect(button).toHaveCSS('scale', '1')

    await page.mouse.up()

    await expect(button).toHaveAttribute('aria-pressed', 'false')

    await disabled.uncheck()
    await button.hover()

    const entry = await button.evaluate(async (element) => {
      await new Promise(requestAnimationFrame)

      return {
        scale: parseFloat(getComputedStyle(element).scale),
        active: element.getAnimations().length,
      }
    })

    expect(entry.active).toBeGreaterThan(0)
    expect(entry.scale).toBeGreaterThanOrEqual(1)
    expect(entry.scale).toBeLessThan(1.08)

    await page.mouse.move(0, 0)

    await expectBrowserScale(button)
    await expect.poll(() => button.evaluate((element) => element.getAnimations().length)).toBe(0)
  })
})

test('toggle reactive animation retargets from its displayed midpoint', async ({ page }) => {
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

test('composition selectors preview independently and restore application presentation', async ({
  page,
}) => {
  await page.goto(`${base}/toggle`)
  const button = page.getByRole('switch', { name: 'Notifications', exact: true })
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()

  await expect(page.getByLabel('From selection enabled')).not.toBeChecked()
  await expect(page.getByLabel('To selection enabled')).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save to source' })).toBeDisabled()

  await page.getByLabel('To selection enabled').check()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await expect(button).toHaveAttribute('aria-checked', 'false')
  await expect(button).toHaveCSS('background-color', 'rgb(52, 178, 123)')

  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await expect(button).toHaveCSS('background-color', 'rgb(136, 136, 136)')

  await button.click()

  await expect(button).toHaveAttribute('aria-checked', 'true')
  await expect(button).toHaveCSS('background-color', 'rgb(52, 178, 123)')
})
