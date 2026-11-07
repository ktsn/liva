import { test, expect, type Page } from '@playwright/test'
import fixture from '../../fixtures/interaction.json' with { type: 'json' }
import type { ReactiveSubscription } from '../../packages/runtime/src/reactive-value.ts'
import type { LivaInstance } from '../../packages/runtime/src/instance.ts'

declare global {
  interface Window {
    browserInputs: {
      interaction: typeof import('../../packages/runtime/src/builtins/interaction.ts').interaction
      drag: typeof import('../../packages/runtime/src/builtins/drag.ts').drag
    }
    interactions: {
      subscription: ReactiveSubscription
      sibling: ReactiveSubscription
      cleanup: () => void
      siblingCleanup: () => void
      updates: number
      instance: LivaInstance
      siblingInstance: LivaInstance
      drag?: ReactiveSubscription
    }
  }
}

async function setup(page: Page, initiallyFocused = false) {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate(
    ({ definitionFixture, focusedOnBind }) => {
      const { interaction } = window.browserInputs
      document.body.innerHTML =
        '<button id="target">Target</button><button id="sibling">Sibling</button><div id="parent"><button id="child-a">Child A</button><button id="child-b">Child B</button></div>'
      const target = document.getElementById('target')!
      const sibling = document.getElementById('sibling')!

      if (focusedOnBind) target.focus()

      const subscription = interaction({ target: { name: 'body' } })
      const other = interaction({ target: { name: 'body' } })
      const state = {
        subscription,
        sibling: other,
        updates: 0,
        cleanup: () => {},
        siblingCleanup: () => {},
        siblingInstance: new window.liva.LivaInstance(
          window.liva.decodeBundle(JSON.stringify(definitionFixture)).definitions[0],
        ),
        instance: new window.liva.LivaInstance(
          window.liva.decodeBundle(JSON.stringify(definitionFixture)).definitions[0],
        ),
      }
      state.cleanup = subscription.bind(new Map([['body', target]]), () => {
        state.updates++
      })
      state.siblingCleanup = other.bind(new Map([['body', sibling]]), () => {})
      state.instance.bind([['body', target]])
      state.siblingInstance.bind([['body', sibling]])
      window.interactions = state
    },
    { definitionFixture: fixture, focusedOnBind: initiallyFocused },
  )
}

async function expectMatching(page: Page, target = 'target') {
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const element = document.getElementById(id)!
        const selectors = {
          hover: ':hover',
          active: ':active',
          focus: ':focus',
          focusVisible: ':focus-visible',
          focusWithin: ':focus-within',
        }
        const value = window.interactions.subscription.value

        if (typeof value !== 'object') throw new Error('Expected an interaction snapshot')

        const layers = window.interactions.instance.composition.layers
        const names: Record<string, string> = {
          hover: 'hover',
          active: 'active',
          focus: 'focus',
          focusVisible: 'visible',
          focusWithin: 'within',
        }

        return Object.entries(selectors).every(
          ([member, selector]) =>
            value[member] === element.matches(selector) && layers[names[member]] === value[member],
        )
      }, target),
    )
    .toBe(true)
}

test('interaction initializes from DOM matching without a transient animation', async ({
  page,
}) => {
  await setup(page, true)
  await expectMatching(page)

  expect(await page.evaluate(() => window.interactions.instance.animations.length)).toBe(0)
  expect(await page.evaluate(() => window.interactions.instance.composition.layers.focus)).toBe(
    true,
  )
})

test('interaction follows native mouse and keyboard pseudo-classes independently', async ({
  page,
}) => {
  await setup(page)
  const target = page.locator('#target')

  await target.hover()
  await expectMatching(page)
  await page.mouse.down()
  await expectMatching(page)
  expect(await page.evaluate(() => window.interactions.sibling.value)).toMatchObject({
    hover: false,
    active: false,
  })

  expect(
    await page.evaluate(() => window.interactions.siblingInstance.composition.layers),
  ).toMatchObject({ hover: false, active: false })

  await page.mouse.up()
  await expectMatching(page)
  await page.keyboard.press('Tab')
  await target.focus()
  await expect(target).toBeFocused()
  await expectMatching(page)

  for (const key of ['Space', 'Enter']) {
    await page.keyboard.down(key)
    await expectMatching(page)
    await page.keyboard.up(key)
    await expectMatching(page)
  }
})

test('interaction avoids duplicate notifications for unchanged browser state', async ({ page }) => {
  await setup(page)
  await page.locator('#target').focus()
  await expectMatching(page)

  const previous = await page.evaluate(() => window.interactions.updates)
  await page.evaluate(() => {
    document.dispatchEvent(new Event('pointermove'))
    document.dispatchEvent(new Event('pointermove'))
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

  expect(await page.evaluate(() => window.interactions.updates)).toBe(previous)
})

test('interaction tracks descendant focus after replacing the target binding', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const { instance, subscription, cleanup } = window.interactions
    const parent = document.getElementById('parent')!
    cleanup()
    window.interactions.cleanup = subscription.bind(new Map([['body', parent]]), () => {
      window.interactions.updates++
    })
    instance.bind([['body', parent]])
  })

  await page.locator('#child-a').focus()
  await expectMatching(page, 'parent')
  await page.locator('#child-b').focus()
  await expectMatching(page, 'parent')
  await page.locator('#sibling').focus()
  await expectMatching(page, 'parent')
})

test('interaction releases listeners when instances are disposed', async ({ page }) => {
  await setup(page)
  await page.locator('#target').focus()
  await expectMatching(page)

  await page.evaluate(() => {
    window.interactions.cleanup()
    window.interactions.siblingCleanup()
    window.interactions.instance.dispose()
    window.interactions.siblingInstance.dispose()
  })
  const previous = await page.evaluate(() => window.interactions.updates)
  await page.locator('#child-a').focus()
  await page.locator('#target').hover()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

  expect(await page.evaluate(() => window.interactions.updates)).toBe(previous)
})

test('interaction coexists with drag capture on the same target', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const { drag } = window.browserInputs
    const target = document.getElementById('target')!
    const subscription = drag({ target: { name: 'body' } })
    const cleanup = subscription.bind(new Map([['body', target]]), () => {})
    window.interactions.drag = subscription
    const previous = window.interactions.cleanup
    window.interactions.cleanup = () => {
      previous()
      cleanup()
    }
  })
  await page.locator('#target').hover()
  await page.mouse.down()
  await page.mouse.move(160, 100)
  await expectMatching(page)
  expect(await page.evaluate(() => window.interactions.drag?.value)).toMatchObject({ active: true })
  await page.mouse.up()
  await expectMatching(page)

  expect(await page.evaluate(() => window.interactions.drag?.value)).toMatchObject({
    active: false,
    released: true,
  })

  await page.evaluate(() => window.interactions.cleanup())
})

test('touch and pen observations equal the browser CSS state', async ({
  page,
  browserName,
  context,
}) => {
  test.skip(browserName !== 'chromium', 'Touch and pen dispatch requires Chromium CDP')
  await setup(page)
  const session = await context.newCDPSession(page)
  const box = (await page.locator('#target').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await expectMatching(page)
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expectMatching(page)

  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      pointerType: 'pen',
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: 1,
    })
    await expectMatching(page)
  }

  await session.detach()
})
