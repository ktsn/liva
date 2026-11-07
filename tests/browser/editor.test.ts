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
  await page.getByLabel('Track duration', { exact: true }).fill('700')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'thumb.scale 40%', exact: true }).click()
  await expect(page.getByLabel('Keyframe percentage', { exact: true })).toHaveValue('40')

  await track(page, 'thumb', 'translate')
  await expect(page.getByRole('button', { name: 'New keyframe at playhead' })).toBeDisabled()
  await page.getByLabel('Timing mode').selectOption('spring-duration')
  await page.getByLabel('Track duration').fill('400')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await expect(page.getByLabel('Track duration', { exact: true })).toHaveValue('400')
})

test('playback pauses and close releases preview effects while retaining draft', async ({
  page,
}) => {
  await open(page)
  await track(page, 'thumb', 'scale')
  await page.getByLabel('Track duration', { exact: true }).fill('3000')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
  await expectMessage(page, 'Previewing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => page.getByLabel('Playhead').inputValue()).not.toBe('0')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const time = await page.getByLabel('Playhead').inputValue()
  await expect(page.getByLabel('Playhead')).toHaveValue(time)

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await expect(page.getByLabel('Track duration', { exact: true })).toHaveValue('3000')
})

async function controlledPlayback(page: Page) {
  await open(page)
  await seek(page, 0)
  await page.clock.install()
  await page.clock.pauseAt(new Date())
}

async function timelineDuration(page: Page) {
  const readout = await page.getByLabel('Playback time').innerText()
  return Number(readout.split('/')[1]?.replace('ms', '').trim())
}

async function expectPlayhead(page: Page, position: number) {
  // The most recent RAF can lag the clock by one 16 ms frame.
  expect(Math.abs((await playhead(page)) - position)).toBeLessThanOrEqual(17)
}

async function playhead(page: Page) {
  return Number(await page.getByLabel('Playhead').inputValue())
}

test('speed scales animation time and changes continuously during playback', async ({ page }) => {
  await controlledPlayback(page)
  const duration = await timelineDuration(page)
  await expect(page.getByRole('combobox', { name: 'Speed', exact: true })).toHaveValue('1')
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.1')
  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })

  await page.clock.runFor(1000)
  await expectPlayhead(page, 100)

  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.5')
  await expectPlayhead(page, 100)

  await page.clock.runFor(200)
  await expectPlayhead(page, 200)

  await page.getByRole('button', { name: 'Pause', exact: true }).click({ force: true })
  const paused = await playhead(page)

  await page.clock.runFor(1000)
  expect(await playhead(page)).toBe(paused)

  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
  await page.clock.runFor(100)
  await expectPlayhead(page, paused + 50)

  await page.clock.runFor(duration * 2)
  await expect(page.getByLabel('Playback time')).toHaveText(`${duration} / ${duration} ms`)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.draft)).toEqual([])
})

test('loop carries elapsed time, preserves speed, and stops after the current pass', async ({
  page,
}) => {
  await controlledPlayback(page)
  const duration = await timelineDuration(page)
  const loop = page.getByRole('button', { name: '↻ Loop', exact: true })
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.5')
  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
  await page.clock.runFor(200)

  await loop.click({ force: true })
  await expectPlayhead(page, 100)

  await page.clock.runFor(duration * 4)
  await expectPlayhead(page, 100)
  await expect(loop).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Pause', exact: true }).click({ force: true })
  const paused = await playhead(page)
  await page.clock.runFor(500)
  expect(await playhead(page)).toBe(paused)

  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
  await loop.click({ force: true })
  await page.clock.runFor(duration * 2)
  await expect(page.getByLabel('Playback time')).toHaveText(`${duration} / ${duration} ms`)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await loop.click({ force: true })
  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
  await page.getByRole('button', { name: 'End preview', exact: true }).click({ force: true })
  const ended = await playhead(page)
  await page.clock.runFor(1000)
  expect(await playhead(page)).toBe(ended)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.draft)).toEqual([])
})

test('playback preferences survive form remounts and reset on reload', async ({ page }) => {
  await open(page)
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('0.25')
  const loop = page.getByRole('button', { name: '↻ Loop', exact: true })
  await loop.focus()
  await page.keyboard.press('Space')
  await expect(loop).toBeFocused()
  await expect(loop).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Speed', exact: true })).toHaveValue('0.25')
  await expect(loop).toHaveAttribute('aria-pressed', 'true')

  await open(page)
  await expect(page.getByRole('combobox', { name: 'Speed', exact: true })).toHaveValue('1')
  await expect(loop).toHaveAttribute('aria-pressed', 'false')
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
    await page.getByLabel('Track duration', { exact: true }).fill('200')
    await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
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
    expect(saved).toContain('@tween(duration: 200, easing: ease)')
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
    await page.getByLabel('Source value', { exact: true }).fill('green')
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
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
  await page.getByLabel('Track duration', { exact: true }).fill('600')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page.getByLabel('Playhead')).toBeVisible()
  await track(page, 'thumb', 'scale')
  await expect(page.getByLabel('Track duration', { exact: true })).toHaveValue('350')

  for (const action of ['close', 'application'] as const) {
    await page.getByLabel('Track duration', { exact: true }).fill('600')
    await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
    await expectMessage(page, 'Previewing')
    await page.getByLabel('Track duration', { exact: true }).fill('700')
    await page.evaluate((operation) => {
      const shadow = document.querySelector('[data-liva-editor]')!.shadowRoot!
      const buttons = [...shadow.querySelectorAll('button')]
      buttons.find((button) => button.textContent?.trim() === 'Apply timing')!.click()
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
      expect.objectContaining({ op: 'timing', value: 'tween(duration: 600, easing: easeOut)' }),
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
  await page.getByLabel('Track duration', { exact: true }).fill('3000')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
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

  await page.getByLabel('Damping', { exact: true }).fill('20')
  await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
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

  await page.getByLabel('Existing transition').selectOption('enter-default')
  await page.getByLabel('Baseline active enabled').uncheck()
  await track(page, 'body', 'opacity')
  await seek(page, 100)

  await expect(first).toHaveCSS('opacity', '0.6')
  await expect(second).toHaveCSS('opacity', '1')
  await expect(first).toHaveAttribute('aria-pressed', 'false')

  await page.getByLabel('Existing transition').selectOption('leave-default')
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

for (const phase of ['enter', 'leave']) {
  test(`${phase} loops seek existing effects without changing presence`, async ({ page }) => {
    await openLifecycle(page)
    await page.getByLabel('Existing transition').selectOption(`${phase}-default`)
    await seek(page, 0)
    const duration = await timelineDuration(page)
    const first = page.getByRole('button', { name: 'First lifecycle', exact: true })

    await page.clock.install()
    await page.clock.pauseAt(new Date())
    await page.getByRole('button', { name: '↻ Loop', exact: true }).click({ force: true })
    await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
    await page.clock.runFor(duration * 3 + 100)

    await expectPlayhead(page, 100)
    await expect(first).toHaveCount(1)
    await expect(first).toBeVisible()
    await expect(first).toHaveAttribute('aria-pressed', 'false')

    await page.getByRole('button', { name: 'End preview', exact: true }).click({ force: true })
    await expect(first).toHaveCSS('opacity', '1')
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  })
}

test('loop settles under reduced motion and permits manual scrubbing', async ({ page }) => {
  await controlledPlayback(page)
  const duration = await timelineDuration(page)
  await page.getByRole('button', { name: '↻ Loop', exact: true }).click({ force: true })
  await page.getByRole('button', { name: 'Play', exact: true }).click({ force: true })
  await page.clock.runFor(100)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.runFor(100)
  await expect(page.getByLabel('Playback time')).toHaveText(`${duration} / ${duration} ms`)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await seek(page, 50)
  await page.clock.runFor(duration * 3)
  expect(await playhead(page)).toBe(50)
})

test('motion-level lifecycle edits save with shared HMR', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const lifecycleFile = new URL('../../playground/tests/EditorLifecycle.vue', import.meta.url)
  const original = await readFile(lifecycleFile, 'utf8')

  try {
    await openLifecycle(page)
    await page.getByLabel('Existing transition').selectOption('enter-default')
    await page.getByLabel('Baseline active enabled').check()
    await track(page, 'body', 'opacity')
    await page.getByRole('button', { name: 'body.opacity 0%', exact: true }).click()
    await page.getByLabel('Keyframe source value', { exact: true }).fill('${start * 2}')
    await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
    await save(page)

    expect(await readFile(lifecycleFile, 'utf8')).toContain('0%: ${start * 2}')

    await page.getByLabel('Existing transition').selectOption('leave-default')
    await page.getByLabel('Baseline active enabled').uncheck()
    await track(page, 'body', 'opacity')
    await page.getByLabel('Track duration', { exact: true }).fill('500')
    await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
    await save(page)

    const saved = await readFile(lifecycleFile, 'utf8')
    expect(saved).toContain('@tween(duration: 200, easing: linear)\n  leave')
    expect(saved).toContain('@tween(duration: 500, easing: linear)')
    expect(saved.slice(0, saved.indexOf('<liva'))).toBe(
      original.slice(0, original.indexOf('<liva')),
    )
  } finally {
    await writeFile(lifecycleFile, original)
  }
})

test.describe('editor source HMR', () => {
  const componentRoot = '../../packages/vite/src/editor/components/'
  const cases = [
    {
      name: 'parent template',
      file: 'EditorPanel.ce.vue',
      from: '>Close</button>',
      to: '>Close editor</button>',
      role: 'button',
      label: 'Close editor',
    },
    {
      name: 'child template',
      file: 'EditorForm.ce.vue',
      from: '>End preview</button>',
      to: '>Stop preview</button>',
      role: 'button',
      label: 'Stop preview',
    },
    {
      name: 'styles',
      file: 'EditorPanel.ce.vue',
      from: 'padding: 12px 20px;',
      to: 'padding: 13px 21px;',
    },
    {
      name: 'script',
      file: 'EditorPanel.ce.vue',
      from: 'const inspectionVersion = ref(0)',
      to: 'const inspectionVersion = ref(1)',
    },
  ] as const

  for (const entry of cases) {
    test(`updates ${entry.name} without a page reload or duplicate hosts`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'A shared source-writing HMR transaction runs once')

      const sourceFile = new URL(componentRoot + entry.file, import.meta.url)
      const original = await readFile(sourceFile, 'utf8')
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))

      try {
        await open(page)
        await track(page, 'thumb', 'scale')
        await page.getByLabel('Track duration', { exact: true }).fill('700')
        await page.getByRole('button', { name: 'Apply timing', exact: true }).click()
        await expectMessage(page, 'Previewing')

        const selected = await page.getByLabel('Preview instance').inputValue()
        const draft = await page.evaluate(() => JSON.stringify(window.__LIVA_EDITOR__.draft))
        await page.evaluate(() => {
          document.documentElement.dataset.hmrDocument = 'original'
        })

        await writeFile(sourceFile, original.replace(entry.from, entry.to))

        if ('label' in entry) {
          await expect(page.getByRole(entry.role, { name: entry.label, exact: true })).toBeVisible()
          await expect(page.getByLabel('Playhead')).toBeVisible()
        } else {
          // Script and custom-element style reloads recreate component-local state.
          const launcher = page.getByRole('button', { name: 'Motion editor', exact: true })
          await expect(launcher).toBeVisible()

          if (entry.name === 'styles')
            await expect(launcher).toHaveCSS('padding-inline-start', '21px')

          await launcher.click()
          await expect(page.getByLabel('Playhead')).toBeVisible()
        }

        await expect(page.getByLabel('Preview instance')).toHaveValue(selected)
        expect(await page.evaluate(() => JSON.stringify(window.__LIVA_EDITOR__.draft))).toBe(draft)
        await expect(page.locator('[data-liva-editor]')).toHaveCount(1)
        expect(await page.evaluate(() => document.documentElement.dataset.hmrDocument)).toBe(
          'original',
        )

        await page
          .getByRole('button', { name: 'Close', exact: true })
          .or(page.getByRole('button', { name: 'Close editor', exact: true }))
          .click()
        await expect(page.getByRole('button', { name: 'Motion editor', exact: true })).toBeVisible()
        expect(errors).toEqual([])
      } finally {
        await writeFile(sourceFile, original)
      }
    })
  }
})
