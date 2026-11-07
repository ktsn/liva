import { expect, test, type Page } from '@playwright/test'

const base = 'http://127.0.0.1:4180'

async function openLikeDemo(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto(`${base}/like-button`)

  return errors
}

test.describe('like button', () => {
  test('keeps liked presentation after its entry celebration ends', async ({ page }) => {
    const errors = await openLikeDemo(page)

    const button = page.getByRole('button', { name: 'Like', exact: true })
    const heart = button.locator('.heart')
    const particles = button.locator('.spark')
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()

    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(() =>
        particles.first().evaluate((element) => Number(getComputedStyle(element).opacity)),
      )
      .toBeGreaterThan(0)
    expect(await heart.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0)
    await expect
      .poll(() => button.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)

    await expect(heart).toHaveCSS('scale', '1')
    await expect(heart).toHaveCSS('color', 'rgb(213, 75, 112)')
    await expect(button).toHaveAttribute('aria-pressed', 'true')

    for (const particle of await particles.all()) await expect(particle).toHaveCSS('opacity', '0')

    expect(errors).toEqual([])
  })

  test('can interrupt and retrigger the celebration through native activation', async ({
    page,
  }) => {
    const errors = await openLikeDemo(page)

    const button = page.getByRole('button', { name: 'Like', exact: true })
    await button.focus()
    await page.keyboard.press('Space')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Space')
    await expect(button).toHaveAttribute('aria-pressed', 'true')

    await expect
      .poll(() =>
        button
          .locator('.spark')
          .first()
          .evaluate((element) => Number(getComputedStyle(element).opacity)),
      )
      .toBeGreaterThan(0)
    await expect
      .poll(() => button.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expect(button.locator('.heart')).toHaveCSS('color', 'rgb(213, 75, 112)')

    await page.keyboard.press('Space')

    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await expect(button.locator('.heart')).toHaveCSS('color', 'rgb(141, 153, 146)')
    await expect
      .poll(() => button.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expect(button.locator('.spark').first()).toHaveCSS('opacity', '0')
    expect(errors).toEqual([])
  })
})
