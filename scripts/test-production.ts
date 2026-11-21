import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { chromium, type Browser, type Page } from '@playwright/test'
import { assertProductionFeatures } from './test-production-features.ts'

const cwd = resolve(import.meta.dirname, '../playground')
const base = 'http://127.0.0.1:4181'

async function inspect(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) {
      await inspect(path)
      continue
    }
    assert(!/\.(wasm|map)$/.test(path), `Unexpected compiler/map artifact: ${path}`)
    const content = await readFile(path, 'utf8')
    for (const marker of [
      '__LIVA_EDITOR__',
      '/__liva/editor',
      'livaSource',
      'X-Liva-Session',
      'Motion editor',
      'Layout configuration (read-only)',
      'applyEdits',
      'wasm_bindgen',
      'sourceId',
      'mappings',
      resolve(cwd, '..'),
    ]) {
      assert(!content.includes(marker), `Production output contains ${marker}`)
    }
  }
}

function layoutReady(expanded: boolean) {
  const list = document.querySelector('[aria-label="Topics"]')
  const details = document.querySelector('#topic-details-garden')
  if (!list || !!details !== expanded) return false

  return (
    list.getAnimations({ subtree: true }).length === 0 &&
    [...list.querySelectorAll<HTMLElement>('[data-topic], .topic-header, .topic-details')].every(
      (element) => element.style.transform === '',
    )
  )
}

/** Waits through retained detail leave, its DOM release, and the later height projection. */
async function settledLayout(page: Page, expanded: boolean) {
  await page.waitForFunction(layoutReady, expanded)
  // Completion may release retained DOM before Vue's next layout transaction.
  // Two native rendering opportunities expose that work; recheck its endpoint.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
  await page.waitForFunction(layoutReady, expanded)
}

async function layoutPlayback(page: Page) {
  await page.goto(`${base}/layout-animation`)
  const list = page.getByRole('list', { name: 'Topics' })
  const garden = page.getByRole('button', { name: 'A garden in a small space', exact: true })
  const gardenCard = page.locator('[data-topic="garden"]')
  await garden.waitFor()
  await settledLayout(page, false)
  const receivers = await page.locator('[data-topic]').elementHandles()
  const closedHeight = await gardenCard.evaluate(
    (element) => element.getBoundingClientRect().height,
  )

  await page.getByRole('button', { name: 'Reverse order', exact: true }).click()
  assert(
    await list.evaluate((element) =>
      [...element.querySelectorAll<HTMLElement>('[data-topic]')].some(
        (card) => card.style.transform !== '',
      ),
    ),
    'Served reorder did not project geometry',
  )
  await settledLayout(page, false)

  assert.deepEqual(
    await page
      .locator('[data-topic]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-topic'))),
    ['table', 'walk', 'garden'],
  )
  for (const receiver of receivers)
    assert(
      await receiver.evaluate((element) => element.isConnected),
      'Reorder replaced a keyed receiver',
    )

  await garden.click()
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-topic="garden"]')?.style.transform,
  )
  await garden.click()
  await settledLayout(page, false)

  assert.equal(await garden.getAttribute('aria-expanded'), 'false')
  assert.equal(
    await gardenCard.evaluate((element) => element.getBoundingClientRect().height),
    closedHeight,
  )
  assert.equal(
    await gardenCard.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    '18px',
  )

  await garden.click()
  await settledLayout(page, true)

  assert.equal(
    await gardenCard.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    '26px',
  )
  assert(
    (await gardenCard.evaluate((element) => getComputedStyle(element).boxShadow)).includes(
      '12px 28px',
    ),
    'Current expanded shadow was not restored',
  )
  assert(
    await gardenCard.evaluate((element) =>
      ['width', 'height', 'inline-size', 'block-size'].every(
        (property) => element.style.getPropertyValue(property) === '',
      ),
    ),
    'Generated dimensions survived playback',
  )

  await garden.click()
  await page.getByRole('link', { name: 'Toggle', exact: true }).click()
  await page.getByRole('switch', { name: 'Notifications' }).waitFor()
  await page.waitForFunction(() => document.getAnimations().length === 0)

  for (const receiver of receivers)
    assert(
      !(await receiver.evaluate((element) => element.isConnected)),
      'Removed route retained an old receiver',
    )
  await page.getByRole('link', { name: 'Layout transitions', exact: true }).click()
  await garden.waitFor()
  await settledLayout(page, false)

  assert.deepEqual(
    await page
      .locator('[data-topic]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-topic'))),
    ['garden', 'walk', 'table'],
  )
  assert.equal(await garden.getAttribute('aria-expanded'), 'false')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await garden.click()
  await settledLayout(page, true)

  assert.equal(
    await gardenCard.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    '26px',
  )
  assert.equal(await list.evaluate((element) => element.getAnimations({ subtree: true }).length), 0)
  await garden.click()
  await settledLayout(page, false)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  assert.equal(
    await gardenCard.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
    '18px',
  )
  assert.equal(await page.locator('[data-liva-editor]').count(), 0)
  assert.equal(await page.evaluate(() => '__LIVA_EDITOR__' in window), false)
}

await assertProductionFeatures()

for (const mode of ['production', 'development']) {
  execFileSync('vp', ['build', '--mode', mode], { cwd, stdio: 'inherit' })
  await inspect(resolve(cwd, 'dist'))
  const server = spawn('vp', ['preview', '--host', '127.0.0.1', '--port', '4181', '--strictPort'], {
    cwd,
    stdio: 'pipe',
    detached: true,
  })
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk
  })
  server.stderr.on('data', (chunk) => {
    output += chunk
  })
  let browser: Browser | undefined
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(output)
      try {
        ready = stripVTControlCharacters(output).includes(base) && (await fetch(base)).ok
      } catch {
        /* Wait for the preview listener. */
      }
      if (ready) break
      await new Promise((done) => setTimeout(done, 100))
    }
    assert(ready, `Preview did not start: ${output}`)
    const response = await fetch(`${base}/__liva/editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert(response.status >= 400, `Editor route accepted POST: ${response.status}`)
    browser = await chromium.launch()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    assert.equal(await page.locator('[data-liva-editor]').count(), 0)
    assert.equal(await page.evaluate(() => '__LIVA_EDITOR__' in window), false)
    const toggle = page.getByRole('switch', { name: 'Notifications' })
    await toggle.click()
    await page.waitForFunction(() => {
      const thumb = document.querySelector('.thumb')
      return (
        thumb &&
        parseFloat(getComputedStyle(thumb).translate) === 24 &&
        document.getAnimations().length === 0
      )
    })
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await page.getByRole('link', { name: 'Beacon', exact: true }).click()
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    assert.equal(await page.getByRole('switch').count(), 0)
    assert.equal(
      await page.getByRole('button', { name: 'Active', exact: true }).getAttribute('aria-pressed'),
      'true',
    )

    await page.goto(`${base}/drag`)
    await page.getByTestId('draggable-card').waitFor()
    assert.equal(await page.getByRole('switch').count(), 0)
    assert.equal(await page.evaluate(() => '__LIVA_EDITOR__' in window), false)
    await layoutPlayback(page)

    assert.deepEqual(errors, [])
    console.log(`Production isolation and playback passed (${mode} mode).`)
  } finally {
    await browser?.close()
    const stopped = new Promise<void>((done) => server.once('exit', done))
    if (server.exitCode === null && server.pid !== undefined) {
      process.kill(-server.pid, 'SIGTERM')
      await stopped
    }
  }
}
