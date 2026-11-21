import type { InstanceBinding } from '../../packages/vue/src/runtime.ts'

declare global {
  interface Window {
    records: Set<InstanceBinding>
    diagnostics: unknown[]
  }
}
import { test, expect } from '@playwright/test'

const base = 'http://127.0.0.1:4180'

test.describe('toggle demo', () => {
  test('mounts OFF and ON side by side with only accessible switch controls', async ({ page }) => {
    await page.goto(base)

    const first = page.getByRole('switch', { name: 'Notifications' })
    const second = page.getByRole('switch', { name: 'Product updates' })
    await expect(page.getByRole('switch')).toHaveCount(2)
    await expect(first).toHaveAttribute('aria-checked', 'false')
    await expect(second).toHaveAttribute('aria-checked', 'true')
    await expect(first).toHaveCSS('background-color', 'rgb(136, 136, 136)')
    await expect(second).toHaveCSS('background-color', 'rgb(52, 178, 123)')
    await expect(first.locator('.thumb')).toHaveCSS('translate', '0px')
    await expect(second.locator('.thumb')).toHaveCSS('translate', '24px')

    const layout = await page.getByRole('switch').evaluateAll((elements) =>
      elements.map((element) => ({
        x: element.getBoundingClientRect().x,
        y: element.getBoundingClientRect().y,
      })),
    )
    expect(layout).toHaveLength(2)

    expect(layout[1].x).toBeGreaterThan(layout[0].x)
    expect(layout[1].y).toBe(layout[0].y)
    await expect(page.locator('.demo-content')).toHaveText('')
  })

  test('animates both directions and retargets an interrupted thumb movement', async ({ page }) => {
    await page.goto(base)

    const first = page.getByRole('switch', { name: 'Notifications' })
    const thumb = first.locator('.thumb')
    await first.click()

    const intermediate = await thumb.evaluate(async (element) => {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)

      return {
        value: parseFloat(getComputedStyle(element).translate),
        animations: element.getAnimations().length,
      }
    })
    expect(intermediate.animations).toBeGreaterThan(0)
    expect(intermediate.value).toBeGreaterThan(0)

    await first.click()

    await expect
      .poll(() => first.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expect(thumb).toHaveCSS('translate', '0px')
    await expect(first).toHaveCSS('background-color', 'rgb(136, 136, 136)')

    await first.click()

    await expect
      .poll(() => first.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expect(thumb).toHaveCSS('translate', '24px')
    await expect(first).toHaveCSS('background-color', 'rgb(52, 178, 123)')
  })

  test('keeps switches independent through keyboard activation and rapid reversals', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)

    const first = page.getByRole('switch', { name: 'Notifications' })
    const second = page.getByRole('switch', { name: 'Product updates' })
    await first.focus()
    await page.keyboard.press('Space')
    await expect(first).toHaveAttribute('aria-checked', 'true')
    await expect(second).toHaveAttribute('aria-checked', 'true')

    for (let i = 0; i < 5; i++) await first.click()

    await expect(first).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(() => first.evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0)
    await expect(first.locator('.thumb')).toHaveCSS('translate', '0px')
    await expect(second.locator('.thumb')).toHaveCSS('translate', '24px')

    await second.focus()
    await page.keyboard.press('Enter')
    await expect(second).toHaveAttribute('aria-checked', 'false')
    await expect(first).toHaveAttribute('aria-checked', 'false')
    expect(errors).toEqual([])
  })
})

test('demo routes mount one demo at a time and support browser navigation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const definitions = () =>
    page.evaluate(() =>
      [...window.__LIVA_EDITOR__.entries.values()]
        .map((entry) => entry.binding.definition.name)
        .toSorted(),
    )

  await page.goto(base)
  await expect(page).toHaveURL(`${base}/toggle`)
  await expect(page.getByRole('switch')).toHaveCount(2)
  await expect.poll(definitions).toEqual(['toggle', 'toggle'])

  await page.getByRole('link', { name: 'Beacon', exact: true }).click()
  await expect(page).toHaveURL(`${base}/beacon`)
  await expect(page.getByRole('link', { name: 'Beacon', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect.poll(definitions).toEqual(['beacon'])
  await page.getByRole('button', { name: 'Activate', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.getByRole('link', { name: 'Drag', exact: true }).click()
  await expect(page).toHaveURL(`${base}/drag`)
  await expect(page.getByTestId('draggable-card')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveCount(0)
  await expect.poll(definitions).toEqual(['card'])

  await page.goBack()
  await expect(page).toHaveURL(`${base}/beacon`)
  await expect(page.getByRole('button', { name: 'Activate', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByTestId('draggable-card')).toHaveCount(0)
  await expect.poll(definitions).toEqual(['beacon'])

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Beacon', exact: true })).toBeVisible()
  await expect.poll(definitions).toEqual(['beacon'])
  expect(errors).toEqual([])
})

test('nearest-root registration handles nested roots and conditional targets', async ({ page }) => {
  await page.goto(`${base}/tests/lifecycle.html`)
  const count = () => page.evaluate(() => window.records.size)
  await expect.poll(count).toBe(2)
  expect(await page.evaluate(() => window.diagnostics)).toEqual([])
  await page.getByRole('button', { name: 'Outer', exact: true }).click()
  await expect
    .poll(() =>
      page.locator('#outer-thumb').evaluate((e) => parseFloat(getComputedStyle(e).translate)),
    )
    .toBe(20)
  expect(
    await page.locator('#inner-thumb').evaluate((e) => parseFloat(getComputedStyle(e).translate)),
  ).toBe(0)

  await page.getByRole('button', { name: 'Target', exact: true }).click()
  await page.getByRole('button', { name: 'Outer', exact: true }).click()
  await page.getByRole('button', { name: 'Target', exact: true }).click()
  await expect
    .poll(() =>
      page.locator('#outer-thumb').evaluate((e) => parseFloat(getComputedStyle(e).translate)),
    )
    .toBe(0)
  await page.getByRole('button', { name: 'Inner', exact: true }).click()
  await page.getByRole('button', { name: 'Mount', exact: true }).click()
  await expect.poll(count).toBe(0)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test(
  'invalid source retains last valid definition and fixed source resumes HMR',
  { lock: '-exclusive-' },
  async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'A shared source-writing HMR transaction runs once')
    const { readFile, writeFile } = await import('node:fs/promises')
    const file = new URL('../../playground/tests/Hmr.vue', import.meta.url)
    const original = await readFile(file, 'utf8')

    try {
      await page.goto(`${base}/tests/hmr.html`)
      const button = page.getByRole('button')
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)')

      const updated = await page.evaluateHandle(async (origin) => {
        const { createHotContext } = await import(`${origin}/@vite/client`)
        const hot = createHotContext('/tests/hmr-observer')

        return {
          finished: new Promise<void>((resolve) => {
            const complete = ({ updates }: { updates: { path: string }[] }) => {
              if (!updates.some(({ path }) => path.includes('/tests/Hmr.vue'))) return

              hot.off('vite:afterUpdate', complete)
              resolve()
            }

            hot.on('vite:afterUpdate', complete)
          }),
        }
      }, base)

      await writeFile(file, original.replace('duration: 50', 'duration: invalid'))

      await expect
        .poll(async () => (await page.request.get(`${base}/tests/Hmr.vue?raw`)).text())
        .toContain('invalid')

      await updated.evaluate(({ finished }) => finished)

      await updated.dispose()

      await button.click()
      await expect(button).toHaveCSS('background-color', 'rgb(0, 0, 255)')
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)

      await writeFile(file, original.replace('background-color: red', 'background-color: green'))
      await expect(button).toHaveCSS('background-color', 'rgb(0, 128, 0)')
      await expect.poll(() => button.evaluate((e) => e.getAnimations().length)).toBe(0)
    } finally {
      await writeFile(file, original)
    }
  },
)

test('generated Presence preserves authored local components and directives', async ({ page }) => {
  await page.goto(`${base}/tests/feature-layout.html`)
  const authored = page.getByTestId('authored-presence')

  await expect(authored).toHaveText('Authored component')
  await expect(authored).toHaveAttribute('data-authored', 'true')

  const setup = page.getByTestId('authored-setup-presence')
  await expect(setup).toHaveText('Authored setup component')
  await expect(setup).toHaveAttribute('data-authored', 'true')
})

test('projects a sibling from its retained position when local Presence removes the leave DOM', async ({
  page,
}) => {
  await page.goto(`${base}/tests/feature-layout.html`)
  const remove = page.getByRole('button', { name: 'Remove first item' })
  const departing = page.getByTestId('departing')
  const survivor = page.getByTestId('survivor')
  const top = () => survivor.evaluate((element) => element.getBoundingClientRect().top)
  const before = await top()

  const observation = await survivor.evaluateHandle((element) => ({
    done: new Promise<{ top: number; projected: boolean }>((resolve) => {
      const observer = new MutationObserver(() => {
        if (element.parentElement?.querySelector('[data-testid="departing"]')) return

        observer.disconnect()
        queueMicrotask(() =>
          resolve({
            top: element.getBoundingClientRect().top,
            projected: getComputedStyle(element).transform !== 'none',
          }),
        )
      })

      observer.observe(element.parentElement!, { childList: true })
    }),
  }))

  await remove.click()

  await expect(departing).toBeVisible()
  await expect.poll(() => departing.evaluate((element) => element.getAnimations().length)).toBe(1)
  expect(await top()).toBe(before)

  const handoff = await observation.evaluate(({ done }) => done)

  await observation.dispose()

  // Capture precedes removal, then the renderer compensates from the previous
  // geometry in the same microtask checkpoint, before the first painted frame.
  expect(handoff).toEqual({ top: before, projected: true })
  await expect(departing).toHaveCount(0)
  await expect(survivor).toHaveCSS('transform', 'none')
  expect(await top()).toBeLessThan(before)
})

test(
  'hot updates add and remove spring imports with their live definition',
  { lock: '-exclusive-' },
  async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'A shared source-writing HMR transaction runs once')
    const { readFile, writeFile } = await import('node:fs/promises')
    const file = new URL('../../playground/tests/Hmr.vue', import.meta.url)
    const original = await readFile(file, 'utf8')
    const spring = original.replace('tween(duration: 50)', 'spring(duration: 600, bounce: 0.2)')
    const invalid = spring.replace('duration: 600', 'duration: invalid')
    const tween = original.replace('duration: 50', 'duration: 250')

    try {
      await page.goto(`${base}/tests/hmr.html`)
      const button = page.getByRole('button')
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)')

      const moduleCode = async () => {
        const response = await page.request.get(
          `${base}/tests/Hmr.vue?vue&type=liva&index=0&lang=liva`,
        )

        return response.text()
      }
      const duration = () =>
        button.evaluate(
          (element) => element.getAnimations()[0]?.effect?.getComputedTiming().duration,
        )

      await writeFile(file, spring)
      await expect.poll(moduleCode).toContain('springPlayback')
      await button.click()
      await expect.poll(duration).toBe(600)
      await expect(button).toHaveCSS('background-color', 'rgb(0, 0, 255)')

      await writeFile(file, invalid)
      await expect
        .poll(async () => (await page.request.get(`${base}/tests/Hmr.vue?raw`)).text())
        .toContain('duration: invalid')
      await expect.poll(moduleCode).toContain('springPlayback')
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)

      const wasActive = (await button.textContent())?.includes('true')
      await button.click()
      await expect.poll(duration).toBe(600)
      await expect(button).toHaveCSS(
        'background-color',
        wasActive ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)',
      )

      await writeFile(file, tween)
      await expect.poll(moduleCode).not.toContain('springPlayback')
      await expect(button).toHaveText('HMR false')

      await button.click()
      await expect.poll(duration).toBe(250)
      await expect(button).toHaveCSS('background-color', 'rgb(0, 0, 255)')
    } finally {
      await writeFile(file, original)
    }
  },
)

test(
  'keeps a valid Motion after HMR rejects a conflicting Presence structure',
  { lock: '-exclusive-' },
  async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'A shared source-writing HMR transaction runs once')
    const { readFile, writeFile } = await import('node:fs/promises')
    const file = new URL('../../playground/tests/Hmr.vue', import.meta.url)
    const original = await readFile(file, 'utf8')
    const withLeave = original.replace(
      '  @tween(duration: 50)',
      '  @tween(duration: 400) leave { box { opacity: 0 } }\n  @tween(duration: 50)',
    )
    const conflict = withLeave
      .replace('<button v-liva', '<Transition><button v-if="true" v-liva')
      .replace('</button>', '</button></Transition>')
    const corrected = withLeave.replace('<button v-liva', '<button v-if="true" v-liva')
    const loader = `${base}/tests/Hmr.vue?vue&type=liva&index=0&lang=liva`

    try {
      await page.goto(`${base}/tests/hmr.html`)
      const button = page.getByRole('button')
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)')
      const rejected = await page.evaluateHandle(async (origin) => {
        const { createHotContext } = await import(`${origin}/@vite/client`)
        const hot = createHotContext('/tests/presence-hmr-observer')
        const diagnostics = new Promise<string>((resolve) => {
          const receive = (event: { diagnostics: { message: string }[] }) => {
            hot.off('liva:diagnostics', receive)
            resolve(event.diagnostics.map(({ message }) => message).join('\n'))
          }

          hot.on('liva:diagnostics', receive)
        })

        return { diagnostics }
      }, base)

      await writeFile(file, conflict)
      expect(await rejected.evaluate(({ diagnostics }) => diagnostics)).toContain(
        'Vue Transition conflicts with Liva lifecycle ownership',
      )
      await rejected.dispose()
      const code = await (await page.request.get(loader)).text()
      expect(code).not.toContain('PresenceExecution')
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)
      await button.click()
      await expect(button).toHaveCSS('background-color', 'rgb(0, 0, 255)')

      await writeFile(file, corrected)
      await expect
        .poll(async () => (await page.request.get(loader)).text())
        .toContain('PresenceExecution')
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)')
    } finally {
      await writeFile(file, original)
    }
  },
)
