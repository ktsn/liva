import { expect, test, type Page } from '@playwright/test'

async function finishAnimations(page: Page) {
  await page.evaluate(async () => {
    const animations = document.getAnimations()
    for (const animation of animations) animation.finish()
    await Promise.all(animations.map((animation) => animation.finished))
  })
}

async function presentation(page: Page, id = 'card') {
  return page.locator('#' + id).evaluate((element) => {
    const style = getComputedStyle(element)
    return { opacity: style.opacity, scale: style.scale, translate: style.translate }
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original Animation receiver.
    const play = Animation.prototype.play
    Animation.prototype.play = function () {
      play.call(this)
      this.pause()
      this.currentTime = 0
    }
  })
  await page.goto('http://127.0.0.1:4180/tests/state-lifecycle.html')
  await expect
    .poll(() => page.locator('#card').evaluate((element) => element.getAnimations().length))
    .toBe(3)
})

test('motion-level enter retains its displayed start when expressions update', async ({ page }) => {
  expect(await presentation(page)).toEqual({ opacity: '0', scale: '0.8', translate: '40px' })
  await expect(page.locator('#badge')).toHaveCSS('opacity', '0')

  await page.locator('#distance').click()
  expect(await presentation(page)).toEqual({ opacity: '0', scale: '0.8', translate: '40px' })
  await finishAnimations(page)

  expect(await presentation(page)).toEqual({ opacity: '1', scale: '1', translate: '0px' })
  await expect(page.locator('#badge')).toHaveCSS('opacity', '1')
  expect(await page.evaluate(() => window.diagnostics)).toEqual([])
})

for (const [button, id, removal] of [
  ['remove', 'card', true],
  ['hide', 'shown-card', false],
] as const) {
  test(`captures motion-level leave before ${removal ? 'disposal' : 'hiding'}`, async ({
    page,
  }) => {
    await finishAnimations(page)
    const card = page.locator('#' + id)
    await card.evaluate((element: HTMLElement) => {
      element.style.opacity = '0.42'
    })
    expect(
      await page.evaluate(() =>
        [...window.records].some((record) => record.label === 'panel Card Badge'),
      ),
    ).toBe(true)
    await page.locator('#' + button).click()

    await expect.poll(() => card.evaluate((element) => element.getAnimations().length)).toBe(3)
    expect(await presentation(page, id)).toEqual({ opacity: '0.42', scale: '1', translate: '0px' })
    if (removal)
      expect(
        await page.evaluate(() =>
          [...window.records].some((record) => record.label === 'panel Card Badge'),
        ),
      ).toBe(false)

    await page.locator('#distance').click()
    await page.locator('#toggle-state').click()
    const endpoints = await card.evaluate((element) =>
      element
        .getAnimations()
        .map((animation) =>
          animation.effect instanceof KeyframeEffect
            ? animation.effect.getKeyframes().at(-1)
            : undefined,
        ),
    )

    expect(endpoints.some((frame) => frame?.translate === (removal ? '40px' : '90px'))).toBe(true)
    expect(endpoints.some((frame) => frame?.scale === '1.2')).toBe(true)
    await card.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.currentTime = 999
    })
    expect(Number((await presentation(page, id)).scale)).toBeCloseTo(1.2, 2)
    await finishAnimations(page)

    if (removal) await expect(card).toHaveCount(0)
    else await expect(card).toBeHidden()
    expect(await page.evaluate(() => window.diagnostics)).toEqual([])
  })
}

test('untimed ordinary changes cancel only their enter tracks while the boundary keeps waiting', async ({
  page,
}) => {
  const enteringScale = await page.locator('#card').evaluateHandle((element) => {
    const animation = element
      .getAnimations()
      .find(
        (candidate) =>
          candidate.effect instanceof KeyframeEffect &&
          candidate.effect.getKeyframes()[0].scale !== undefined,
      )

    if (!animation) throw new Error('Expected enter scale effect')

    return animation
  })

  await page.locator('#toggle-state').click()

  expect(await presentation(page)).toEqual({ opacity: '0', scale: '0.9', translate: '40px' })

  await expect(page.locator('#card')).toHaveCSS('border-radius', '0px')

  const endpoints = await page
    .locator('#card')
    .evaluate((element) =>
      element
        .getAnimations()
        .map((animation) =>
          animation.effect instanceof KeyframeEffect
            ? animation.effect.getKeyframes().at(-1)
            : undefined,
        ),
    )

  expect(endpoints.some((frame) => frame?.scale !== undefined)).toBe(false)
  expect(endpoints).toHaveLength(2)
  expect(await enteringScale.evaluate((animation) => animation.playState)).toBe('idle')

  await enteringScale.dispose()

  await finishAnimations(page)

  expect(await presentation(page)).toEqual({ opacity: '1', scale: '0.9', translate: '0px' })

  await page.locator('#remove').click()
  await finishAnimations(page)

  await expect(page.locator('#card')).toHaveCount(0)

  await page.locator('#remove').click()

  await expect
    .poll(() => page.locator('#card').evaluate((element) => element.getAnimations().length))
    .toBe(3)

  await finishAnimations(page)

  expect(await presentation(page)).toEqual({ opacity: '1', scale: '0.9', translate: '0px' })
})
