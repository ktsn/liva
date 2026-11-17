import { expect, test, type Page } from '@playwright/test'

// An isolated consumer check can supply its owned server; standard verification
// uses the same playground endpoint as the other browser integration tests.
const base = process.env.LIVA_LAYOUT_DEMO_URL ?? 'http://127.0.0.1:4180'
const garden = 'A garden in a small space'

test.use({ viewport: { width: 1100, height: 1000 }, video: 'on' })

async function openDemo(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })

  await page.goto(`${base}/layout-animation`)
  await expect(page.getByRole('heading', { name: 'Layout transitions', exact: true })).toBeVisible()

  return errors
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      page
        .getByRole('list', { name: 'Topics' })
        .evaluate((list) => list.getAnimations({ subtree: true }).length),
    )
    .toBe(0)
}

async function order(page: Page) {
  return page
    .getByRole('listitem')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-topic')))
}

test.describe('layout transitions consumer', () => {
  test('preserves keyed card state, DOM identity and keyboard focus through reorder', async ({
    page,
  }) => {
    const errors = await openDemo(page)
    const toggle = page.getByRole('button', { name: garden, exact: true })
    await toggle.click()
    await settled(page)
    const cards = await page.getByRole('listitem').elementHandles()

    await page.getByRole('button', { name: 'Reverse order', exact: true }).click()
    await settled(page)

    expect(await order(page)).toEqual(['table', 'walk', 'garden'])
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const card of cards) expect(await card.evaluate((node) => node.isConnected)).toBe(true)

    const move = page.getByRole('button', { name: `Move ${garden} down`, exact: true })
    await move.focus()
    await move.press('Enter')
    await settled(page)

    expect(await order(page)).toEqual(['garden', 'table', 'walk'])
    await expect(move).toBeFocused()
    await expect(page.getByRole('status')).toHaveText(`${garden} moved to position 1 of 3.`)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await page.getByRole('button', { name: 'Reverse order', exact: true }).click()
    await settled(page)

    expect(await order(page)).toEqual(['walk', 'table', 'garden'])
    expect(errors).toEqual([])
  })

  test('reverses expansion while active and retains content until the actual leave ends', async ({
    page,
  }) => {
    const errors = await openDemo(page)
    const toggle = page.getByRole('button', { name: garden, exact: true })
    const card = page.locator('[data-topic="garden"]')
    const details = page.locator('#topic-details-garden')
    const closed = await card.evaluate((node) => node.getBoundingClientRect().height)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(details).toBeVisible()
    await expect
      .poll(() =>
        card.evaluate((node) => {
          if (!(node instanceof HTMLElement)) throw new Error('Expected topic card')

          const height = node.getBoundingClientRect().height
          return height > node.offsetHeight - 1 ? 'settled' : 'active'
        }),
      )
      .toBe('active')

    await toggle.click()

    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(details).toBeAttached()
    await expect(details).not.toBeAttached()
    await settled(page)
    await expect
      .poll(() => card.evaluate((node) => node.getBoundingClientRect().height))
      .toBe(closed)

    await toggle.click()
    await page.getByRole('button', { name: 'Reverse order', exact: true }).click()
    await settled(page)

    await expect(details).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(card).toHaveCSS('border-radius', '26px')
    expect(errors).toEqual([])
  })

  test('keeps narrow keyboard controls usable with native reduced-motion changes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 850 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = await openDemo(page)
    const toggle = page.getByRole('button', { name: garden, exact: true })

    await toggle.focus()
    await toggle.press('Space')
    await settled(page)

    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('#topic-details-garden').getByRole('link')).toHaveAttribute(
      'href',
      'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Flow_layout',
    )

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await toggle.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await settled(page)

    await expect(page.locator('#topic-details-garden')).not.toBeAttached()
    await expect(toggle).toBeFocused()
    expect(errors).toEqual([])
  })

  test('releases an active route and returns with fresh card state', async ({ page }) => {
    const errors = await openDemo(page)
    await page.getByRole('button', { name: garden, exact: true }).click()

    await page.getByRole('link', { name: 'Toggle', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Notifications' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Topics' })).not.toBeAttached()
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)

    await page.getByRole('link', { name: 'Layout transitions', exact: true }).click()

    expect(await order(page)).toEqual(['garden', 'walk', 'table'])
    await expect(page.getByRole('button', { name: garden, exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await settled(page)
    expect(errors).toEqual([])
  })
})
