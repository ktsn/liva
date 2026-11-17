import { expect, test, type Page } from '@playwright/test'

const base = 'http://127.0.0.1:4180'
const names = ['Closed', 'Half', 'Expanded']

test.use({ viewport: { width: 1000, height: 1150 }, video: 'on' })

// Leave a rendered result in each recording before its context closes.
test.afterEach(async ({ page }) => {
  await page.waitForTimeout(250)
})

async function openSheet(page: Page) {
  const errors: string[] = []

  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })

  await page.goto(`${base}/bottom-sheet`)
  await expect(page.getByRole('slider', { name: 'Sheet position' })).toHaveAttribute(
    'aria-valuenow',
    '1',
  )

  return errors
}

async function geometry(page: Page) {
  return page.getByTestId('sheet-frame').evaluate((frame) => {
    const bounds = frame.getBoundingClientRect()
    const sheet = frame.querySelector('.bottom-sheet')!.getBoundingClientRect()

    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      sheetY: sheet.y - bounds.y,
    }
  })
}

async function expectSnap(page: Page, snap: number) {
  const handle = page.getByRole('slider', { name: 'Sheet position' })

  await expect(handle).toHaveAttribute('aria-valuenow', String(snap))
  await expect(handle).toHaveAttribute('aria-valuetext', names[snap])
  // Measurements coalesce on the next animation frame after a resize. Wait for
  // the actual destination as well as effect completion, rather than mistaking
  // the gap before measurement publication for an already settled animation.
  await expect
    .poll(async () => {
      const bounds = await geometry(page)
      const destination = [bounds.height - 56, bounds.height * 0.5, bounds.height * 0.1][snap]

      return Math.abs(bounds.sheetY - destination)
    })
    .toBeLessThan(0.75)
  await expect
    .poll(() =>
      page.getByTestId('bottom-sheet').evaluate((element) => element.getAnimations().length),
    )
    .toBe(0)
}

async function grab(page: Page) {
  const handle = page.getByRole('slider', { name: 'Sheet position' })

  await handle.scrollIntoViewIfNeeded()

  const box = (await handle.boundingBox())!

  await handle.evaluate((element) => {
    element.addEventListener(
      'pointerdown',
      (event) => {
        if (!(event instanceof PointerEvent)) throw new Error('Expected pointer input')

        const sheet = element.closest('.bottom-sheet')!

        element.setAttribute('data-pointer-id', String(event.pointerId))
        element.setAttribute('data-pointer-x', String(event.clientX))
        element.setAttribute('data-pointer-y', String(event.clientY))
        element.setAttribute('data-before-grab', getComputedStyle(sheet).insetBlockStart)

        queueMicrotask(() => {
          element.setAttribute('data-after-grab', getComputedStyle(sheet).insetBlockStart)
        })
      },
      { once: true, capture: true },
    )
  })

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()

  return handle.evaluate((element) => ({
    x: Number(element.getAttribute('data-pointer-x')),
    y: Number(element.getAttribute('data-pointer-y')),
    id: Number(element.getAttribute('data-pointer-id')),
    before: parseFloat(element.getAttribute('data-before-grab')!),
    after: parseFloat(element.getAttribute('data-after-grab')!),
  }))
}

async function dragTo(page: Page, sheetY: number, hold = true) {
  const point = await grab(page)

  await page.mouse.move(point.x, point.y + sheetY - point.after, { steps: 4 })

  if (hold) await page.waitForTimeout(150)

  await page.mouse.up()
}

test.describe('bottom sheet', () => {
  test('opens through navigation with a persistent half sheet and interactive background', async ({
    page,
  }) => {
    await page.goto(`${base}/toggle`)
    await page.getByRole('link', { name: 'Bottom sheet', exact: true }).click()
    await expectSnap(page, 1)

    const bounds = await geometry(page)

    expect(bounds.width).toBe(393)
    expect(bounds.height).toBe(852)

    await page.getByRole('button', { name: 'Save this route' }).click()

    await expect(page.getByRole('button', { name: 'Route saved' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expectSnap(page, 1)
  })

  test('keeps keyboard destinations synchronized after drag releases and repeated older commands', async ({
    page,
  }) => {
    const errors = await openSheet(page)
    const handle = page.getByRole('slider')

    await handle.focus()

    for (const [key, snap] of [
      ['End', 2],
      ['ArrowDown', 1],
      ['Home', 0],
      ['ArrowUp', 1],
    ] as const) {
      await handle.press(key)
      await expectSnap(page, snap)
    }

    await handle.press('End')
    await expect(handle).toHaveAttribute('aria-valuenow', '2')
    await dragTo(page, 750)
    await expectSnap(page, 0)
    await page.waitForTimeout(150)
    await expectSnap(page, 0)

    await handle.press('End')
    await expectSnap(page, 2)
    await dragTo(page, 430)
    await expectSnap(page, 1)
    await handle.press('ArrowDown')
    await expectSnap(page, 0)
    await expect(handle).toBeFocused()

    expect(errors).toEqual([])
  })

  test('retargets a running spring and suppresses sheet keys during direct manipulation', async ({
    page,
  }) => {
    await openSheet(page)

    const handle = page.getByRole('slider')

    await handle.press('End')
    await expect(handle).toHaveAttribute('aria-valuenow', '2')
    await handle.press('Home')
    await expectSnap(page, 0)
    await handle.press('ArrowUp')
    await expectSnap(page, 1)

    const point = await grab(page)

    await page.mouse.move(point.x, point.y - 50)
    await handle.press('Home')
    await handle.press('End')
    await expect(handle).toHaveAttribute('aria-valuenow', '1')
    await page.waitForTimeout(150)
    await page.mouse.up()
    await expectSnap(page, 1)
  })

  for (const { title, fraction, snap } of [
    { title: 'nearest half after a stationary hold', fraction: 0.6, snap: 1 },
    { title: 'nearest closed after a stationary hold', fraction: 0.88, snap: 0 },
    { title: 'nearest expanded after a stationary hold', fraction: 0.2, snap: 2 },
  ]) {
    test(`selects ${title}`, async ({ page }) => {
      await openSheet(page)

      const bounds = await geometry(page)

      await dragTo(page, bounds.height * fraction)
      await expectSnap(page, snap)
    })
  }

  test('gives exact midpoint ties to the more open state and distinguishes adjacent positions', async ({
    page,
  }) => {
    await openSheet(page)

    // 327.5 × 710 is an exact responsive frame size. Its snap midpoints have
    // binary-exact .5/integer coordinates, avoiding synthetic-input rounding
    // masquerading as an exact tie in a different browser's PointerEvent.
    await page.getByTestId('sheet-frame').evaluate((element) => {
      element.style.inlineSize = '327.5px'
    })
    await expect.poll(async () => (await geometry(page)).height).toBe(710)
    await expectSnap(page, 1)

    for (const { position, snap } of [
      { position: 505.5, snap: 0 },
      { position: 504.5, snap: 1 },
      { position: 503.5, snap: 1 },
      { position: 214, snap: 1 },
      { position: 213, snap: 2 },
      { position: 212, snap: 2 },
    ]) {
      const handle = page.getByRole('slider')

      await handle.press('Home')
      await expectSnap(page, 0)
      await handle.press('ArrowUp')
      await expectSnap(page, 1)

      const point = await grab(page)

      // Preserve native capture while supplying exact fractional terminal input.
      await handle.dispatchEvent('pointermove', {
        pointerId: point.id,
        clientX: point.x,
        clientY: point.y + position - point.after,
      })
      await page.waitForTimeout(150)
      await handle.dispatchEvent('pointerup', {
        pointerId: point.id,
        clientX: point.x,
        clientY: point.y + position - point.after,
      })
      await page.mouse.up()
      await expectSnap(page, snap)
    }
  })

  test('projects fast releases far enough to skip the intermediate snap', async ({ page }) => {
    await openSheet(page)
    await page.getByRole('slider').press('Home')
    await expectSnap(page, 0)

    for (const [direction, snap] of [
      [-1, 2],
      [1, 0],
    ] as const) {
      const point = await grab(page)

      await page.mouse.move(point.x, point.y + direction * 80)
      await page.waitForTimeout(16)
      await page.mouse.move(point.x, point.y + direction * 180)
      await page.mouse.up()
      await expectSnap(page, snap)
    }
  })

  test('allows unrestricted overdrag at both ends and returns to a snap', async ({ page }) => {
    await openSheet(page)

    for (const [destination, snap] of [
      [-80, 2],
      [900, 0],
    ] as const) {
      const point = await grab(page)
      const handle = page.getByRole('slider')

      await handle.evaluate((element) => {
        element.addEventListener(
          'pointermove',
          (event) => {
            if (!(event instanceof PointerEvent)) throw new Error('Expected pointer input')

            element.setAttribute('data-move-y', String(event.clientY))
          },
          { once: true },
        )
      })
      await page.mouse.move(point.x, point.y + destination - point.after)

      // Native mouse backends may round requested fractional coordinates. Check
      // against the actual browser-delivered delta, with CSS subpixel tolerance.
      const expected = point.after + Number(await handle.getAttribute('data-move-y')) - point.y
      const actual = (await geometry(page)).sheetY

      expect(Math.abs(actual - expected)).toBeLessThan(0.75)
      expect(destination < 0 ? actual < 0 : actual > 852).toBe(true)

      await page.waitForTimeout(150)
      await page.mouse.up()
      await expectSnap(page, snap)
    }
  })

  test('anchors repeated spring regrabs and supports dragging in reverse', async ({ page }) => {
    await openSheet(page)
    await page.getByRole('slider').press('Home')
    await expectSnap(page, 0)
    await page.getByRole('slider').press('End')
    await page.waitForTimeout(70)

    for (let attempt = 0; attempt < 2; attempt++) {
      const point = await grab(page)
      const before = (await geometry(page)).sheetY

      // Both reads surround pointerdown within one task: spring progress cannot
      // account for a discontinuity. Only computed-style serialization may round.
      expect(Math.abs(point.after - point.before)).toBeLessThan(0.01)

      await page.mouse.move(point.x, point.y + 70)

      expect(Math.abs((await geometry(page)).sheetY - before - 70)).toBeLessThan(0.75)

      await page.waitForTimeout(150)
      await page.mouse.up()
      await page.waitForTimeout(60)
    }

    await dragTo(page, 760)
    await expectSnap(page, 0)
  })

  for (const cancellation of ['pointercancel', 'lostpointercapture']) {
    test(`returns to the interrupted destination after ${cancellation}`, async ({ page }) => {
      await openSheet(page)

      const handle = page.getByRole('slider')

      await handle.press('Home')
      await expectSnap(page, 0)
      await handle.press('End')
      await page.waitForTimeout(70)
      const point = await grab(page)

      await page.mouse.move(point.x, point.y + 250)

      if (cancellation === 'lostpointercapture') {
        await handle.evaluate((element) => {
          element.releasePointerCapture(Number(element.getAttribute('data-pointer-id')))
        })
      } else {
        await handle.dispatchEvent('pointercancel', {
          pointerId: Number(await handle.getAttribute('data-pointer-id')),
        })
      }

      await page.mouse.up()
      await expectSnap(page, 2)
    })
  }

  test('scrolls content independently with mouse and keyboard and preserves visible handle focus', async ({
    page,
  }) => {
    await openSheet(page)

    const content = page.getByLabel('Places to explore')
    const handle = page.getByRole('slider')

    await content.hover()
    await page.mouse.wheel(0, 400)
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    await expectSnap(page, 1)

    await content.focus()
    await page.keyboard.press('End')
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
        ),
      )
      .toBe(true)
    await expectSnap(page, 1)
    await page.keyboard.press('Shift+Tab')
    await expect(handle).toBeFocused()
    await expect(handle).toHaveCSS('outline-style', 'solid')
    await expect(handle).toHaveCSS('outline-width', '3px')
  })

  test('scales the frame while retaining the 56px closed header', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 900 })
    await openSheet(page)

    const bounds = await geometry(page)

    expect(bounds.width).toBeLessThan(393)
    expect(Math.abs(bounds.height / bounds.width - 852 / 393)).toBeLessThan(0.001)

    await expectSnap(page, 1)
    await page.getByRole('slider').press('Home')
    await expectSnap(page, 0)
    await page.getByRole('button', { name: 'Save this route' }).click()
    await expect(page.getByRole('button', { name: 'Route saved' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.getByRole('slider').press('End')
    await expectSnap(page, 2)
    await page.setViewportSize({ width: 400, height: 900 })
    await expectSnap(page, 2)
  })

  test('keeps direct manipulation responsive and settles releases immediately with reduced motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openSheet(page)

    const point = await grab(page)
    const before = (await geometry(page)).sheetY

    await page.mouse.move(point.x, point.y - 250)

    expect(Math.abs((await geometry(page)).sheetY - before + 250)).toBeLessThan(0.75)

    await page.waitForTimeout(150)
    await page.mouse.up()

    expect(
      await page.getByTestId('bottom-sheet').evaluate((element) => element.getAnimations().length),
    ).toBe(0)

    await expectSnap(page, 2)
    await page.getByRole('slider').press('Home')

    expect(
      await page.getByTestId('bottom-sheet').evaluate((element) => element.getAnimations().length),
    ).toBe(0)

    await expectSnap(page, 0)
  })

  test('prevents header drag text selection while preserving native content selection', async ({
    page,
  }) => {
    await openSheet(page)

    for (const [destination, snap] of [
      [180, 2],
      [750, 0],
    ] as const) {
      await dragTo(page, destination)
      await expectSnap(page, snap)

      expect(await page.evaluate(() => getSelection()?.toString())).toBe('')
    }

    await page.getByRole('slider').press('End')
    await expectSnap(page, 2)
    await page.getByText('Make a little room for discovery.').dblclick()

    expect(await page.evaluate(() => getSelection()?.toString().length)).toBeGreaterThan(0)
  })

  test('supports touch header dragging and native touch content scrolling', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Native touch sequences require Chromium CDP; desktop mouse coverage runs in every browser',
    )
    await openSheet(page)

    const session = await context.newCDPSession(page)
    const box = (await page.getByRole('slider').boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + 28

    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - 250 }],
    })
    await page.waitForTimeout(150)
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expectSnap(page, 2)

    const content = page.getByLabel('Places to explore')
    const contentBox = (await content.boundingBox())!
    const startY = contentBox.y + contentBox.height - 50

    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY }],
    })

    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY - step * 50 }],
      })
      await page.waitForTimeout(25)
    }

    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(50)
    await expectSnap(page, 2)
    await session.detach()
  })
})
