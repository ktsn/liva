import { expect, test, type Page } from '@playwright/test'

async function openDemo(page: Page) {
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }))
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('http://127.0.0.1:4180/')
  await page.getByRole('link', { name: 'Photo tape', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Photo tape' })).toBeVisible()
  return errors
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      page.locator('.photo-stage').evaluate((el) => el.getAnimations({ subtree: true }).length),
    )
    .toBe(0)
}

async function expectPose(page: Page, open: boolean) {
  await expect(page.getByRole('button', { name: 'Open photo' })).toHaveAttribute(
    'aria-pressed',
    String(open),
  )
  await expect(page.locator('.photo-card')).toHaveCSS('scale', open ? '1.06' : '1')
  for (const tape of await page.locator('.tape').all()) {
    await expect(tape).toHaveCSS('opacity', open ? '0.55' : '1')
    await expect(tape).toHaveCSS('scale', open ? '1.18' : '1')
    await expect(tape).toHaveCSS(
      'box-shadow',
      open ? 'rgba(23, 61, 54, 0.15) 0px 16px 14px 0px' : 'rgba(23, 61, 54, 0.25) 0px 1px 2px 0px',
    )
  }
}

test('photo tape opens and closes through the playground navigation and keyboard', async ({
  page,
}) => {
  const errors = await openDemo(page)
  await expectPose(page, false)
  await page.getByRole('button', { name: 'Open photo' }).focus()
  await page.keyboard.press('Enter')
  await settled(page)
  await expectPose(page, true)
  await page.keyboard.press('Space')
  await settled(page)
  await expectPose(page, false)
  expect(errors).toEqual([])
})

test('tapes hold above the closed card before their staggered landings', async ({ page }) => {
  const errors = await openDemo(page)
  const button = page.getByRole('button', { name: 'Open photo' })
  await button.click()
  await settled(page)
  await button.click()
  await expect
    .poll(() => page.locator('.tape-left').evaluate((el) => el.getAnimations().length))
    .toBeGreaterThan(0)

  // Seek the real browser effects together, avoiding wall-clock sampling races.
  await page.locator('.photo-stage').evaluate(async (el) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = 425
    }
    await new Promise(requestAnimationFrame)
  })
  await expect(page.locator('.photo-card')).toHaveCSS('scale', '1')
  await expect(page.locator('.photo-card')).toHaveCSS('rotate', '0deg')
  for (const tape of await page.locator('.tape').all()) {
    await expect(tape).toHaveCSS('scale', '1.18')
    await expect(tape).toHaveCSS('opacity', '0.55')
  }
  await expect(page.locator('.tape-left')).toHaveCSS('translate', '-12px -38px')
  await expect(page.locator('.tape-right')).toHaveCSS('translate', '12px -32px')

  await page.locator('.photo-stage').evaluate(async (el) => {
    for (const animation of el.getAnimations({ subtree: true })) animation.currentTime = 520
    await new Promise(requestAnimationFrame)
  })
  expect(
    await page.locator('.tape-left').evaluate((el) => Number(getComputedStyle(el).scale)),
  ).toBeLessThan(1.18)
  await expect(page.locator('.tape-right')).toHaveCSS('scale', '1.18')
  // Opacity has started while the left shadow still holds: independent property timing.
  expect(
    await page.locator('.tape-left').evaluate((el) => Number(getComputedStyle(el).opacity)),
  ).toBeGreaterThan(0.55)
  await expect(page.locator('.tape-left')).toHaveCSS(
    'box-shadow',
    'rgba(23, 61, 54, 0.15) 0px 16px 14px 0px',
  )
  await page.locator('.photo-stage').evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) animation.play()
  })
  await settled(page)
  await expectPose(page, false)
  expect(errors).toEqual([])
})

test('rapid reversal cancels old landings and survives navigation away', async ({ page }) => {
  const errors = await openDemo(page)
  const button = page.getByRole('button', { name: 'Open photo' })
  await button.focus()
  await page.keyboard.press('Enter')
  await settled(page)
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await page.keyboard.press('Enter')
  await settled(page)
  // Observe beyond the entire abandoned close, not just the shorter new opening.
  await page.waitForTimeout(1100)
  await expectPose(page, true)
  await page.keyboard.press('Space')
  await page.getByRole('link', { name: 'Toggle', exact: true }).click()
  await page.getByRole('link', { name: 'Photo tape', exact: true }).click()
  await page.waitForTimeout(1100)
  await expectPose(page, false)
  expect(errors).toEqual([])
})

async function seek(page: Page, milliseconds: number) {
  await page.locator('.photo-stage').evaluate(async (el, time) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = time
    }
    await new Promise(requestAnimationFrame)
  }, milliseconds)
}

async function tapePoses(page: Page) {
  return page.locator('.tape').evaluateAll((elements) =>
    elements.map((el) => {
      const style = getComputedStyle(el)
      return {
        scale: Number(style.scale),
        opacity: Number(style.opacity),
        translate: style.translate,
        shadow: style.boxShadow,
      }
    }),
  )
}

test('intermediate reversals preserve the displayed pose without a stale landing', async ({
  page,
}) => {
  const errors = await openDemo(page)
  const button = page.getByRole('button', { name: 'Open photo' })
  await button.click()
  await settled(page)
  await button.click()
  await seek(page, 700)
  const landing = await tapePoses(page)
  expect(landing[0].scale).toBeGreaterThan(1)
  expect(landing[0].scale).toBeLessThan(1.18)

  await button.click()
  await seek(page, 0)
  expect(await tapePoses(page)).toEqual(landing)
  await seek(page, 36)
  const lifting = await tapePoses(page)
  for (const [index, pose] of lifting.entries()) {
    expect(pose.scale).toBeGreaterThan(landing[index].scale)
    expect(pose.opacity).toBeLessThan(landing[index].opacity)
  }
  // Every property must begin at the interrupted pose, with no hardcoded detour.
  await page.locator('.tape').evaluateAll((elements) => {
    for (const el of elements) {
      for (const animation of el.getAnimations()) animation.play()
    }
  })
  await page.locator('.photo-card').evaluate((el) => {
    for (const animation of el.getAnimations()) animation.play()
  })
  await settled(page)
  await page.waitForTimeout(1100)
  await expectPose(page, true)

  await button.click()
  await settled(page)
  await button.click()
  await seek(page, 180)
  const partialLift = await tapePoses(page)
  expect(partialLift[0].scale).toBeGreaterThan(1)
  expect(partialLift[0].scale).toBeLessThan(1.18)
  await button.click()
  await seek(page, 0)
  expect(await tapePoses(page)).toEqual(partialLift)
  await seek(page, 425)
  expect(await tapePoses(page)).toEqual(partialLift)
  await expect(page.locator('.photo-card')).toHaveCSS('scale', '1')
  await page.locator('.photo-stage').evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) animation.play()
  })
  await settled(page)
  await expectPose(page, false)
  expect(errors).toEqual([])
})

test('photo tape respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Observe every frame, including before eventual-pose assertions can hide active motion.
  await page.addInitScript(() => {
    const active: number[] = []
    Object.assign(window, { photoTapeActiveFrames: active })
    function sample() {
      const stage = document.querySelector('.photo-stage')
      if (stage) active.push(stage.getAnimations({ subtree: true }).length)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const errors = await openDemo(page)
  const button = page.getByRole('button', { name: 'Open photo' })
  await button.click()
  await expectPose(page, true)
  await settled(page)
  await button.click()
  await expectPose(page, false)
  await settled(page)
  const observation = await page.evaluate(() => {
    const frames: unknown = Reflect.get(window, 'photoTapeActiveFrames')
    return {
      sampled: Array.isArray(frames) && frames.length > 0,
      still: Array.isArray(frames) && frames.every((count: unknown) => count === 0),
    }
  })
  expect(observation).toEqual({ sampled: true, still: true })
  expect(errors).toEqual([])
})
