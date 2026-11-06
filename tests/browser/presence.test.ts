import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    exiting: Element
    dismissals: number
    probeUnmounted: boolean
    retained: Element
    teardown(): void
    effects: Animation[]
    childExit: Animation
  }
}

const base = 'http://127.0.0.1:4180'

test('swipe removes application data immediately and retains the exiting element', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + '/swipe')
  const card = page.getByTestId('swipe-1')
  await expect(card).toBeVisible()
  await card.evaluate((element) => {
    Object.assign(window, { exiting: element, dismissals: 0 })
    element.addEventListener('liva-dismiss', () => {
      const state = window
      state.dismissals++
    })
  })

  const box = (await card.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 210, box.y + 30, { steps: 5 })
  await page.mouse.up()

  await expect(page.getByTestId('item-count')).toHaveText('2 items')
  expect(
    await page.evaluate(() => {
      const state = window
      return {
        connected: state.exiting.isConnected,
        count: state.dismissals,
        effects: state.exiting.getAnimations().length,
      }
    }),
  ).toEqual({ connected: true, count: 1, effects: 2 })
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('swipe-2')).toBeVisible()
  expect(errors).toEqual([])
})

test('ancestor boundaries aggregate targets and nested motions after disposal', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#content')).toBeVisible()
  await page.waitForTimeout(150)
  await page.evaluate(() => {
    document.addEventListener('probe-unmounted', () =>
      Object.assign(window, { probeUnmounted: true }),
    )
  })
  await page.locator('#toggle').click()

  expect(await page.evaluate(() => window.probeUnmounted)).toBe(true)
  expect(
    await page.evaluate(() => [...window.records].some((record) => record.root.id === 'nested')),
  ).toBe(false)
  expect(await page.locator('#ancestor').count()).toBe(1)
  expect(
    await page.locator('#secondary').evaluate((element) => element.getAnimations().length),
  ).toBe(1)
  await page.waitForTimeout(320)
  expect(await page.locator('#ancestor').count()).toBe(1)
  await expect(page.locator('#ancestor')).toHaveCount(0)

  await page.locator('#toggle').click()
  await expect(page.locator('#content')).toBeVisible()
  await expect(page.locator('#content')).toHaveCSS('color', 'rgb(12, 34, 56)')
  expect(errors).toEqual([])
})

test('persisted ancestor transitions delay hiding and discard obsolete hides', async ({ page }) => {
  await page.goto(base + '/tests/presence.html')
  const element = page.locator('#show-ancestor')
  await expect(element).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#show').click()

  expect(await element.evaluate((node) => getComputedStyle(node).display)).not.toBe('none')
  await page.waitForTimeout(50)
  await page.locator('#show').click()
  await page.waitForTimeout(400)
  await expect(element).toBeVisible()

  await page.locator('#show').click()
  await expect(element).toBeHidden()
  await page.locator('#show').click()
  await expect(element).toBeVisible()
})

test('conditional chains and ancestor keyed lists retain identity until completion', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#first')).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#branch').click()

  expect(await page.locator('#first').count()).toBe(1)
  await expect(page.locator('#second')).toBeVisible()
  await expect(page.locator('#first')).toHaveCount(0)
  await page.locator('#branch').click()
  await expect(page.locator('#third')).toBeVisible()
  await expect(page.locator('#second')).toHaveCount(0)

  await page.locator('#row-2').evaluate((element) => Object.assign(window, { retained: element }))
  await page.locator('#remove').click()
  expect(await page.locator('#row-1').count()).toBe(1)
  await expect(page.locator('#row-1')).toHaveCount(0)
  expect(await page.locator('#row-2').evaluate((element) => element === window.retained)).toBe(true)
})

test('parent teardown cancels running sessions and releases every animation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#content')).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#toggle').click()
  await page.evaluate(() => {
    const effects = document.getAnimations()
    Object.assign(window, { effects })
    window.teardown()
  })

  await expect(page.locator('#app')).toBeEmpty()
  expect(
    await page.evaluate(() => window.effects.every((effect) => effect.playState === 'idle')),
  ).toBe(true)
  expect(await page.evaluate(() => window.records.size)).toBe(0)
  expect(errors).toEqual([])
})

test('below-threshold release returns to idle without dismissal and repeated removals clean up', async ({
  page,
}) => {
  await page.goto(base + '/swipe')
  const card = page.getByTestId('swipe-1')
  await expect(card).toBeVisible()
  const box = (await card.boundingBox())!

  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + 30)
  await page.mouse.up()

  await expect(page.getByTestId('item-count')).toHaveText('3 items')
  await expect
    .poll(() => card.evaluate((element) => parseFloat(getComputedStyle(element).translate)))
    .toBe(0)

  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLButtonElement>('.swipe-card button')
      .forEach((button) => button.click())
  })

  await expect(page.getByTestId('item-count')).toHaveText('0 items')
  await expect(page.locator('.swipe-card')).toHaveCount(0)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('direct target loops, conditionals, visibility and Motion-root removal share lifecycle semantics', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#repeated-1')).toHaveCSS('opacity', '0.8')
  await expect(page.locator('#repeated-2')).toHaveCSS('opacity', '0.8')
  await page.waitForTimeout(150)

  await page.locator('#remove').click()
  expect(await page.locator('#repeated-1').count()).toBe(1)
  await expect(page.locator('#repeated-1')).toHaveCount(0)
  await expect(page.locator('#repeated-2')).toHaveCSS('opacity', '0.8')

  await page.locator('#toggle').click()
  expect(await page.locator('#direct').count()).toBe(1)
  await expect(page.locator('#direct')).toHaveCount(0)

  await page.locator('#show').click()
  expect(
    await page.locator('#direct-visibility').evaluate((node) => getComputedStyle(node).display),
  ).not.toBe('none')
  await expect(page.locator('#direct-visibility')).toBeHidden()

  await page.locator('#root-toggle').click()
  expect(await page.locator('#motion-root').count()).toBe(1)
  await expect(page.locator('#motion-root')).toHaveCount(0)
})

test('destroying a nested boundary cancels its existing exit instead of transferring it', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#nested')).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#inner-toggle').click()
  await page.locator('#nested').evaluate((element) => {
    Object.assign(window, { childExit: element.getAnimations()[0] })
  })

  await page.locator('#toggle').click()

  expect(await page.evaluate(() => window.childExit.playState)).toBe('idle')
  await expect(page.locator('#ancestor')).toHaveCount(0)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('recreating the same conditional branch during leave preserves the new DOM', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#content')).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#toggle').click()
  await page.locator('#toggle').click()

  await page.waitForTimeout(600)
  await expect(page.locator('#ancestor')).toHaveCount(1)
  await expect(page.locator('#content')).toHaveCSS('opacity', '1')
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('enter initializes before paint and cancelled WAAPI leave still completes removal', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  await expect(page.locator('#content')).toBeVisible()
  await page.waitForTimeout(150)
  await page.locator('#toggle').click()
  await expect(page.locator('#content')).toHaveCount(0)

  const initial = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('#toggle')!.click()
    await Promise.resolve()
    const element = document.querySelector('#content')!
    const effect = element.getAnimations()[0].effect
    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected keyframes')
    return {
      initial: effect.getKeyframes()[0].opacity,
      displayed: getComputedStyle(element).opacity,
    }
  })

  expect(initial.initial).toBe('0')
  expect(Number(initial.displayed)).toBeLessThan(0.3)
  await expect(page.locator('#content')).toHaveCSS('opacity', '1')
  await page.locator('#toggle').click()
  await page.locator('#secondary').evaluate((element) => element.getAnimations()[0].cancel())
  await expect(page.locator('#ancestor')).toHaveCount(0)
})

test('reduced motion completes lifecycle barriers without lingering effects', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(base + '/swipe')
  await page.getByTestId('swipe-1').getByRole('button').click()

  await expect(page.getByTestId('swipe-1')).toHaveCount(0)
  await expect(page.getByTestId('item-count')).toHaveText('2 items')
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('reset restores only removed cards and preserves remaining elements', async ({ page }) => {
  await page.goto(base + '/swipe')
  await expect(page.locator('.swipe-card')).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.getByTestId('swipe-2').evaluate((element) => {
    window.retained = element
  })

  await page.getByTestId('swipe-1').getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByTestId('item-count')).toHaveText('2 items')
  await page.getByRole('button', { name: 'Reset cards' }).click()

  await expect(page.locator('.swipe-card')).toHaveCount(3)
  await expect(page.getByTestId('item-count')).toHaveText('3 items')
  const frames = await page
    .getByTestId('swipe-1')
    .evaluate((element) =>
      element
        .getAnimations()
        .flatMap((animation) =>
          animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [],
        ),
    )
  expect(frames.some((frame) => frame.opacity === '0')).toBe(true)
  expect(await page.getByTestId('swipe-2').evaluate((element) => element === window.retained)).toBe(
    true,
  )
  expect(
    await page.getByTestId('swipe-2').evaluate((element) => element.getAnimations().length),
  ).toBe(0)
  expect(
    await page.getByTestId('swipe-3').evaluate((element) => element.getAnimations().length),
  ).toBe(0)

  await expect(page.getByTestId('swipe-1')).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: 'Reset cards' }).click()
  await expect(page.locator('.swipe-card')).toHaveCount(3)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('presence metadata preserves parameter objects with colliding names on updates', async ({
  page,
}) => {
  await page.goto(base + '/tests/presence.html')
  const manual = page.locator('#manual-binding')
  const parameters = page.locator('#parameter-binding')

  await expect(manual).toHaveCSS('opacity', '1')
  await expect(parameters).toHaveCSS('opacity', '1')
  await page.locator('#binding-update').click()

  await expect(manual).toHaveCSS('opacity', '0.4')
  await expect(parameters).toHaveCSS('opacity', '0.3')
  expect(await page.evaluate(() => window.diagnostics)).toEqual([])
})
