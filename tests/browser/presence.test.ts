import { expect, test, type Locator, type Page } from '@playwright/test'
import { setGestureTime } from './gesture-time.ts'

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

/** Release with CSS-pixel offsets from pointer-down and performance.now() times in milliseconds. */
async function releaseTimedSwipe(
  page: Page,
  face: Locator,
  moves: { time: number; offset: number }[],
  releaseTime: number,
) {
  const box = await face.boundingBox()

  if (!box) {
    throw new Error('Expected a visible swipe face')
  }

  await setGestureTime(page, 1000)

  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()

  for (const move of moves) {
    await setGestureTime(page, move.time)

    await page.mouse.move(box.x + 30 + move.offset, box.y + 30)
  }

  await setGestureTime(page, releaseTime)

  await page.mouse.up()
}

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
  const midpoint = await page.evaluate(() => {
    const effects = window.exiting.getAnimations({ subtree: true })
    for (const animation of effects) {
      animation.pause()
      animation.currentTime = Number(animation.effect?.getComputedTiming().duration) / 2
    }
    return {
      opacity: Number(getComputedStyle(window.exiting).opacity),
      content: window.exiting.textContent,
    }
  })

  expect(midpoint.opacity).toBeGreaterThan(0)
  expect(midpoint.opacity).toBeLessThan(1)
  expect(midpoint.content).toContain('Item A')
  await page.evaluate(() => {
    for (const animation of window.exiting.getAnimations({ subtree: true })) animation.finish()
  })

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
  expect(
    await page.evaluate(() =>
      [...window.records].some((record) => record.label === 'nested Nested'),
    ),
  ).toBe(true)
  await page.locator('#toggle').click()

  expect(await page.evaluate(() => window.probeUnmounted)).toBe(true)
  expect(
    await page.evaluate(() =>
      [...window.records].some((record) => record.label === 'nested Nested'),
    ),
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

test('short swipes preserve data, outside interaction closes, and repeated removals clean up', async ({
  page,
}) => {
  await page.goto(base + '/swipe')
  const card = page.getByTestId('swipe-1')
  await expect(card).toBeVisible()
  const box = (await card.boundingBox())!

  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + 30)
  await page.waitForTimeout(100)
  await page.mouse.up()

  await expect(page.getByTestId('item-count')).toHaveText('3 items')

  await page.getByRole('heading', { name: 'Swipe actions' }).click()
  await expect
    .poll(() =>
      card
        .locator('.swipe-face')
        .evaluate((element) => parseFloat(getComputedStyle(element).translate)),
    )
    .toBe(0)

  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLButtonElement>('.swipe-face button')
      .forEach((button) => button.click())
  })

  await expect(page.getByTestId('item-count')).toHaveText('0 items')
  await expect(page.locator('.swipe-card')).toHaveCount(0)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('swipe rows retain independent snap state and animate opening and outside closure continuously', async ({
  page,
}) => {
  await page.goto(base + '/swipe')
  const first = page.getByTestId('swipe-1')
  const second = page.getByTestId('swipe-2')
  await expect(first).toBeVisible()
  await page.waitForFunction(() => document.getAnimations().length === 0)
  const firstBox = (await first.boundingBox())!
  const firstFace = first.locator('.swipe-face')

  await page.mouse.move(firstBox.x + 30, firstBox.y + 30)
  await page.mouse.down()
  await page.mouse.move(firstBox.x + 100, firstBox.y + 30)
  await page.waitForTimeout(100)
  await page.mouse.up()
  const opening = await firstFace.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Expected opening spring')
    animation.pause()
    animation.currentTime = 40
    return {
      position: parseFloat(getComputedStyle(element).translate),
      height: element.getBoundingClientRect().height,
    }
  })

  expect(opening.position).toBeGreaterThan(70)
  expect(opening.position).toBeLessThan(96)
  expect(opening.height).toBeCloseTo(firstBox.height)
  await firstFace.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish()
  })
  await expect
    .poll(() => firstFace.evaluate((element) => parseFloat(getComputedStyle(element).translate)))
    .toBe(96)

  const secondBox = (await second.boundingBox())!
  await page.mouse.move(secondBox.x + 30, secondBox.y + 30)
  await page.mouse.down()
  await page.mouse.move(secondBox.x + 100, secondBox.y + 30)
  await page.waitForTimeout(100)
  const closing = await firstFace.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Expected outside-close spring')
    animation.pause()
    animation.currentTime = 40
    return {
      position: parseFloat(getComputedStyle(element).translate),
      height: element.getBoundingClientRect().height,
    }
  })

  expect(closing.position).toBeGreaterThan(0)
  expect(closing.position).toBeLessThan(96)
  expect(closing.height).toBeCloseTo(firstBox.height)
  await firstFace.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish()
  })
  await page.mouse.up()

  await expect
    .poll(() => firstFace.evaluate((element) => parseFloat(getComputedStyle(element).translate)))
    .toBe(0)
  await expect
    .poll(() =>
      second
        .locator('.swipe-face')
        .evaluate((element) => parseFloat(getComputedStyle(element).translate)),
    )
    .toBe(96)
  await expect(page.getByTestId('item-count')).toHaveText('3 items')
})

for (const sample of [
  {
    name: 'short flick below the dismissal threshold',
    moves: [{ time: 1010, offset: 5 }],
    releaseTime: 1020,
    destination: 96,
  },
  {
    name: 'short flick beyond the dismissal threshold',
    moves: [{ time: 1010, offset: 20 }],
    releaseTime: 1020,
    destination: 500,
  },
  {
    name: 'stationary release',
    moves: [{ time: 1010, offset: 20 }],
    releaseTime: 1100,
    destination: 0,
  },
  {
    name: 'projection below the opening threshold',
    moves: [{ time: 1040, offset: 7 }],
    releaseTime: 1050,
    destination: 0,
  },
  {
    name: 'projection at the opening threshold',
    moves: [{ time: 1040, offset: 8 }],
    releaseTime: 1050,
    destination: 96,
  },
  {
    name: 'projection at the dismissal threshold',
    moves: [{ time: 1040, offset: 20 }],
    releaseTime: 1050,
    destination: 96,
  },
  {
    name: 'projection above the dismissal threshold',
    moves: [{ time: 1040, offset: 21 }],
    releaseTime: 1050,
    destination: 500,
  },
  {
    name: 'stationary release beyond the dismissal threshold',
    moves: [{ time: 1010, offset: 121 }],
    releaseTime: 1100,
    destination: 500,
  },
  {
    name: 'long swipe reversed before release',
    moves: [
      { time: 1010, offset: 140 },
      { time: 1020, offset: 130 },
    ],
    releaseTime: 1030,
    destination: 0,
  },
]) {
  test(`swipe uses input history for ${sample.name}`, async ({ page }) => {
    await page.goto(base + '/swipe')
    const card = page.getByTestId('swipe-1')
    await expect(card).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().length === 0)
    const face = card.locator('.swipe-face')

    await releaseTimedSwipe(page, face, sample.moves, sample.releaseTime)

    const handoff = await face.evaluate((element) => {
      const animation = element.getAnimations()[0]

      if (!(animation?.effect instanceof KeyframeEffect)) {
        throw new Error('Expected release animation')
      }

      animation.pause()
      const frames = animation.effect.getKeyframes()

      return {
        start: parseFloat(String(frames[0].translate)),
        end: parseFloat(String(frames.at(-1)?.translate)),
      }
    })

    // Every case has at least one move; the last input is the handoff position.
    expect(handoff).toEqual({ start: sample.moves.at(-1)!.offset, end: sample.destination })

    const dismissed = sample.destination === 500
    await expect(page.getByTestId('item-count')).toHaveText(dismissed ? '2 items' : '3 items')

    if (dismissed) {
      await card.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) animation.finish()
      })

      await expect(card).toHaveCount(0)
    }
  })
}

test('swipe regrabs a moving spring without jumping and releases in the reverse direction', async ({
  page,
}) => {
  await page.goto(base + '/swipe')
  const face = page.getByTestId('swipe-1').locator('.swipe-face')
  await expect(face).toBeVisible()
  await page.waitForFunction(() => document.getAnimations().length === 0)

  await releaseTimedSwipe(page, face, [{ time: 1010, offset: 5 }], 1020)

  const displayed = await face.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Expected opening spring')
    animation.pause()
    animation.currentTime = 40
    return parseFloat(getComputedStyle(element).translate)
  })
  const movingBox = (await face.boundingBox())!

  await setGestureTime(page, 2000)

  await page.mouse.move(movingBox.x + 30, movingBox.y + 30)
  await page.mouse.down()

  expect(await face.evaluate((element) => parseFloat(getComputedStyle(element).translate))).toBe(
    displayed,
  )

  await setGestureTime(page, 2010)
  await page.mouse.move(movingBox.x + 20, movingBox.y + 30)
  await setGestureTime(page, 2020)
  await page.mouse.up()

  const destination = await face.evaluate((element) => {
    const animation = element.getAnimations()[0]
    if (!(animation?.effect instanceof KeyframeEffect)) throw new Error('Expected closing spring')
    animation.pause()
    return parseFloat(String(animation.effect.getKeyframes().at(-1)?.translate))
  })

  expect(destination).toBe(0)
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
  await page.getByTestId('swipe-1').getByRole('button', { name: 'Dismiss', exact: true }).click()

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
