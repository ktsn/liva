import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type { EditorController } from '../../packages/vite/src/editor/controller.ts'

declare global {
  interface Window {
    __LIVA_EDITOR__: EditorController
  }
}

const base = 'http://127.0.0.1:4180'
const file = new URL('../../playground/tests/EditorToggle.vue', import.meta.url)

async function open(page: Page, fixture = false) {
  await page.goto(fixture ? `${base}/tests/editor.html` : `${base}/tests/pulse-toggle.html`)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await expect(page.getByLabel('Playhead')).toBeVisible()
  await page
    .getByLabel('Existing transition')
    .selectOption(JSON.stringify({ layer: fixture ? 'selection' : 'toggle', index: 0 }))
}

async function expectMessage(page: Page, message: string) {
  await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.message)).toContain(message)
}

async function seek(page: Page, time: number) {
  await page.getByLabel('Playhead').evaluate((element, position) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected the playhead input')
    element.value = String(position)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, time)
  await expectMessage(page, 'Previewing')
}

async function track(page: Page, target: string, property: string) {
  const toggle = page.getByRole('button', { name: `Toggle ${target} tracks` })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.getByRole('button', { name: `Select ${target}.${property}`, exact: true }).click()
}

async function save(page: Page) {
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'Save to source' }).click()
  await expectMessage(page, 'All shared instances are synchronized')
}

test('docked timeline scrubs both ways, isolates instances, and yields to application state', async ({
  page,
}) => {
  await open(page)
  const first = page.getByRole('switch', { name: 'Notifications', exact: true })
  const second = page.getByRole('switch', { name: 'Product updates', exact: true })
  await expect(page.locator('[data-liva-editor] .editor')).toHaveCSS('position', 'fixed')
  await expect(page.getByRole('button', { name: 'Toggle thumb tracks' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await track(page, 'thumb', 'scale')
  await expect(page.locator('[data-track="thumb.scale"] .key')).toHaveCount(4)

  await seek(page, 350)
  await expect(first).toHaveCSS('background-color', 'rgb(52, 178, 123)')
  await expect(first).toHaveAttribute('aria-checked', 'false')
  await expect(second).toHaveCSS('background-color', 'rgb(136, 136, 136)')
  await seek(page, 0)
  await expect(first).toHaveCSS('background-color', 'rgb(136, 136, 136)')
  await seek(page, 100)
  await expect
    .poll(() => first.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe('rgb(136, 136, 136)')

  await page.getByRole('button', { name: 'End preview', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await expect(first).toHaveCSS('background-color', 'rgb(136, 136, 136)')
  await seek(page, 100)
  await first.click()
  await expect(first).toHaveAttribute('aria-checked', 'true')
  await expectMessage(page, 'Application state superseded')
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await expect(first).toHaveCSS('background-color', 'rgb(52, 178, 123)')
})

test('transition frame edits reject collisions without losing the selected source', async ({
  page,
}) => {
  await open(page)
  await track(page, 'thumb', 'scale')
  await page.getByRole('button', { name: 'thumb.scale 40%', exact: true }).click()
  await page.getByLabel('Keyframe source value', { exact: true }).fill('1.5')
  await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
  await expectMessage(page, 'Previewing')

  await page.getByLabel('Keyframe percentage', { exact: true }).fill('70')
  await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
  await expectMessage(page, 'Duplicate declaration')
  await expect(page.getByRole('button', { name: 'thumb.scale 40%', exact: true })).toBeVisible()
})

test('duration edits preserve frame offsets and spring editing uses typed expressions', async ({
  page,
}) => {
  await open(page)
  await track(page, 'thumb', 'scale')
  await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 700)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'thumb.scale 40%', exact: true }).click()
  await expect(page.getByLabel('Keyframe percentage', { exact: true })).toHaveValue('40')

  await track(page, 'thumb', 'translate')
  await expect(page.getByRole('button', { name: 'New keyframe at playhead' })).toBeDisabled()
  await page.getByLabel('Timing expression', { exact: true }).fill('spring(duration: 400)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await expect(page.getByLabel('Timing expression', { exact: true })).toHaveValue(
    'spring(duration: 400)',
  )
})

test('playback pauses and close releases preview effects while retaining draft', async ({
  page,
}) => {
  await open(page)
  await track(page, 'thumb', 'scale')
  await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 3000)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => page.getByLabel('Playhead').inputValue()).not.toBe('0')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const time = await page.getByLabel('Playhead').inputValue()
  await expect(page.getByLabel('Playhead')).toHaveValue(time)

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await expect(page.getByLabel('Timing expression', { exact: true })).toHaveValue(
    'tween(duration: 3000)',
  )
})

test('timeline saves timing, new frames and endpoint state values with shared HMR', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const original = await readFile(file, 'utf8')
  try {
    await open(page, true)
    await track(page, 'box', 'background-color')
    await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 200)')
    await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
    await expectMessage(page, 'Previewing')
    await seek(page, 100)
    await page.getByRole('button', { name: 'New keyframe at playhead' }).click()
    await page.getByLabel('Keyframe source value', { exact: true }).fill('purple')
    await page.getByRole('button', { name: 'Add keyframe', exact: true }).click()
    await expectMessage(page, 'Previewing')
    expect(await readFile(file, 'utf8')).toBe(original)
    await save(page)

    const saved = await readFile(file, 'utf8')
    expect(saved).toContain('transition off -> on')
    expect(saved).toContain('@tween(duration: 200)')
    expect(saved).toContain('50%')
    expect(saved).toContain('%: purple')
    expect(saved.slice(0, saved.indexOf('<liva'))).toBe(
      original.slice(0, original.indexOf('<liva')),
    )
    await page
      .getByLabel('Existing transition')
      .selectOption(JSON.stringify({ layer: 'selection', index: 0 }))
    await track(page, 'box', 'background-color')
    await page.getByRole('button', { name: 'box.background-color 50%', exact: true }).click()
    await page.getByRole('button', { name: 'Delete keyframe', exact: true }).click()
    await save(page)
    expect(await readFile(file, 'utf8')).not.toContain('purple')

    await track(page, 'box', 'background-color')
    await page.getByLabel('TO source value', { exact: true }).fill('green')
    await page.getByRole('button', { name: 'Apply TO value', exact: true }).click()
    await save(page)
    expect(await readFile(file, 'utf8')).toContain('background-color: green')
  } finally {
    await writeFile(file, original)
  }
})

test('editor rejects invalid sessions, origins, hosts and oversized requests', async ({ page }) => {
  await page.goto(base)
  const module = await (await page.request.get(`${base}/@id/__x00__liva:vue-plugin`)).text()
  const token = module.match(/createDevPlugin\("([^"]+)"\)/)![1]
  const headers = { 'X-Liva-Session': token, Origin: base, 'Content-Type': 'application/json' }
  for (const invalid of [
    { 'X-Liva-Session': 'invalid' },
    { Origin: 'https://example.com' },
    { Host: 'example.com:4180' },
  ] as Record<string, string>[]) {
    const response = await page.request.post(`${base}/__liva/editor`, {
      headers: { ...headers, ...invalid },
      data: {},
    })
    expect(response.status()).toBe(403)
  }
  const oversized = await page.request.post(`${base}/__liva/editor`, {
    headers,
    data: 'x'.repeat(65537),
  })
  expect(oversized.status()).toBe(413)
})

test('timeline pointer gestures seek without changing source frames or timing', async ({
  page,
}) => {
  await open(page, true)
  await track(page, 'box', 'background-color')

  const lane = page.locator('[data-track="box.background-color"]')

  await lane.dblclick({ position: { x: 20, y: 18 }, modifiers: ['Alt'] })
  await expect(page.getByRole('button', { name: 'Add keyframe', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Resize box.background-color', exact: true }),
  ).toHaveCount(0)
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.draft)).toEqual([])
})

test('selection, discard, close and application updates invalidate pending previews', async ({
  page,
}) => {
  await open(page)
  const options = await page
    .getByLabel('Preview instance')
    .locator('option')
    .evaluateAll((elements) =>
      elements.map((option) => {
        if (!(option instanceof HTMLOptionElement)) throw new Error('Expected an instance option')
        return option.value
      }),
    )
  await page.getByLabel('Preview instance').selectOption(options[2])
  await expect(page.getByLabel('Playhead')).toBeVisible()
  await track(page, 'thumb', 'scale')
  await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 600)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page.getByLabel('Playhead')).toBeVisible()
  await track(page, 'thumb', 'scale')
  await expect(page.getByLabel('Timing expression', { exact: true })).toHaveValue(
    'tween(duration: 350, easing: easeOut)',
  )

  for (const action of ['close', 'application'] as const) {
    await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 600)')
    await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
    await expectMessage(page, 'Previewing')
    await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 700)')
    await page.evaluate((operation) => {
      const shadow = document.querySelector('[data-liva-editor]')!.shadowRoot!
      const buttons = [...shadow.querySelectorAll('button')]
      buttons.find((button) => button.textContent?.trim() === 'Apply timing expression')!.click()
      if (operation === 'close')
        buttons.find((button) => button.textContent?.trim() === 'Close')!.click()
      else document.querySelector<HTMLButtonElement>('[aria-label="Product updates"]')!.click()
    }, action)

    // Allow an in-flight server reply to arrive after cancellation.
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(false)
    if (action === 'close')
      await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
    expect(await page.evaluate(() => window.__LIVA_EDITOR__.draft)).toContainEqual(
      expect.objectContaining({ op: 'timing', value: 'tween(duration: 600)' }),
    )
  }
})

test('manual scrubbing survives reduced-motion changes and unmount releases effects', async ({
  page,
}) => {
  await open(page)
  const first = page.getByRole('switch', { name: 'Notifications', exact: true })
  await seek(page, 100)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seek(page, 0)
  await expect(first).toHaveCSS('background-color', 'rgb(136, 136, 136)')
  await seek(page, 350)
  await expect(first).toHaveCSS('background-color', 'rgb(52, 178, 123)')

  await page
    .getByRole('button', { name: 'Unmount switches', exact: true })
    .evaluate((element: HTMLButtonElement) => element.click())
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(false)
})

test('enabling reduced motion during Play settles immediately but still allows scrubbing', async ({
  page,
}) => {
  await open(page)
  await track(page, 'thumb', 'scale')
  await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 3000)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(page.getByLabel('Playhead')).toHaveValue('3000')
  await seek(page, 0)
  await expect(page.getByRole('switch', { name: 'Notifications', exact: true })).toHaveCSS(
    'background-color',
    'rgb(136, 136, 136)',
  )
})

test('an unsettled spring keeps its parameter controls available for correction', async ({
  page,
}) => {
  await page.route('**/__liva/editor', async (route) => {
    const response = await route.fetch()
    const reply = await response.json()
    if (route.request().postDataJSON().action === 'inspect') {
      const property = reply.definition.layers[0].targets
        .find((target: any) => target.name === 'thumb')
        .properties.find((candidate: any) => candidate.name === 'translate')
      property.timingExpression = undefined
      property.timing = { kind: 'spring-physics', stiffness: 300, damping: 0.000001, mass: 1 }
    }
    await route.fulfill({ response, json: reply })
  })
  await open(page)
  await track(page, 'thumb', 'translate')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()

  await page
    .getByLabel('Timing expression', { exact: true })
    .fill('spring(stiffness: 300, damping: 20)')
  await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled()
})

async function openLifecycle(page: Page) {
  await page.goto(`${base}/tests/editor-lifecycle.html`)
  await expect(page.getByRole('button', { name: 'First lifecycle', exact: true })).toHaveCSS(
    'opacity',
    '1',
  )
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await expect(page.getByLabel('Playhead')).toBeVisible()
}

test('lifecycle previews capture templates, isolate instances, scrub and restore without removing DOM', async ({
  page,
}) => {
  await openLifecycle(page)
  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })
  const second = page.getByRole('button', { name: 'Second lifecycle', exact: true })

  await page.getByLabel('Editing scope').selectOption('enter-default')
  await page.getByLabel('Baseline active enabled').uncheck()
  await track(page, 'body', 'opacity')
  await seek(page, 100)

  await expect(first).toHaveCSS('opacity', '0.6')
  await expect(second).toHaveCSS('opacity', '1')
  await expect(first).toHaveAttribute('aria-pressed', 'false')

  await page.getByLabel('Editing scope').selectOption('leave-default')
  await page.getByLabel('Baseline active enabled').uncheck()
  await seek(page, 200)
  await expect(first).toHaveCSS('opacity', '0')
  await expect(first).toHaveCount(1)
  await seek(page, 100)
  await expect(first).toHaveCSS('opacity', '0.5')

  await page.getByRole('button', { name: 'End preview', exact: true }).click()
  await expect(first).toHaveCSS('opacity', '1')
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('motion-level lifecycle edits save with shared HMR', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const lifecycleFile = new URL('../../playground/tests/EditorLifecycle.vue', import.meta.url)
  const original = await readFile(lifecycleFile, 'utf8')

  try {
    await openLifecycle(page)
    await page.getByLabel('Editing scope').selectOption('enter-default')
    await page.getByLabel('Baseline active enabled').check()
    await track(page, 'body', 'opacity')
    await page.getByRole('button', { name: 'body.opacity 0%', exact: true }).click()
    await page.getByLabel('Keyframe source value', { exact: true }).fill('${start * 2}')
    await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
    await save(page)

    expect(await readFile(lifecycleFile, 'utf8')).toContain('0%: ${start * 2}')

    await page.getByLabel('Editing scope').selectOption('leave-default')
    await page.getByLabel('Baseline active enabled').uncheck()
    await track(page, 'body', 'opacity')
    await page.getByLabel('Timing expression', { exact: true }).fill('tween(duration: 500)')
    await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
    await save(page)

    const saved = await readFile(lifecycleFile, 'utf8')
    expect(saved).toContain('leave @tween(duration: 200, easing: linear)')
    expect(saved).toContain('@tween(duration: 500)')
    expect(saved.slice(0, saved.indexOf('<liva'))).toBe(
      original.slice(0, original.indexOf('<liva')),
    )
  } finally {
    await writeFile(lifecycleFile, original)
  }
})
