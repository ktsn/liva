import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

async function open(page: Page) {
  await page.goto('http://127.0.0.1:4180/tests/editor-layer-lifecycle.html')
  await expect(page.getByRole('button', { name: 'First lifecycle', exact: true })).toHaveCSS(
    'opacity',
    '1',
  )
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
}

async function seek(page: Page, time: number) {
  await page.getByLabel('Playhead', { exact: true }).evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected playhead')
    element.value = String(value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, time)
  await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(true)
}

test('composition lifecycle previews isolate instances, retain lifecycle-only rows, and scrub both ways', async ({
  page,
}) => {
  await open(page)
  await page.getByLabel('Editing scope').selectOption('enter-default')
  await page.getByLabel('Baseline active enabled', { exact: true }).check()
  await page.getByRole('button', { name: 'Toggle badge tracks', exact: true }).click()
  await expect(page.getByLabel('Select badge.opacity', { exact: true })).toBeVisible()
  await seek(page, 100)

  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })
  const second = page.getByRole('button', { name: 'Second lifecycle', exact: true })
  await expect(first).toHaveCSS('opacity', '0.5')
  await expect(second).toHaveCSS('opacity', '1')
  await expect(first).toHaveAttribute('aria-pressed', 'false')

  await page.getByLabel('Editing scope').selectOption('leave-default')
  await seek(page, 200)
  await expect(first).toHaveCSS('opacity', '0')
  await expect(first).toHaveCount(1)
  await seek(page, 100)
  await expect(first).toHaveCSS('opacity', '0.4')
  await page.getByRole('button', { name: 'End preview', exact: true }).click()
  await expect(first).toHaveCSS('opacity', '1')
})

test('typed lifecycle source expressions save and reach shared instances through HMR', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const file = new URL('../../playground/tests/EditorLayerLifecycle.vue', import.meta.url)
  const original = await readFile(file, 'utf8')

  try {
    await open(page)
    await page.getByLabel('Editing scope').selectOption('enter-default')
    await page.getByRole('button', { name: 'Toggle body tracks', exact: true }).click()
    await page.getByLabel('Select body.opacity', { exact: true }).click()
    await page.getByLabel('FROM source value', { exact: true }).fill('${start * 2}')
    await page.getByRole('button', { name: 'Apply FROM value', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(true)
    await seek(page, 0)
    await expect(page.getByRole('button', { name: 'First lifecycle', exact: true })).toHaveCSS(
      'opacity',
      '0.4',
    )
    await page.getByRole('button', { name: 'Save to source', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.message)).toContain('Saved')

    const saved = await readFile(file, 'utf8')
    expect(saved).toContain('0%: ${start * 2}')
    expect(saved).toContain('enter @tween(duration: 200, easing: linear)')
    expect(saved.slice(0, saved.indexOf('<liva'))).toBe(
      original.slice(0, original.indexOf('<liva')),
    )
  } finally {
    await writeFile(file, original)
  }
})

test('application inputs end lifecycle preview and the next preview captures updated expressions', async ({
  page,
}) => {
  await open(page)
  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })
  await page.getByLabel('Editing scope').selectOption('enter-default')
  await seek(page, 0)
  await expect(first).toHaveCSS('opacity', '0.2')

  await page.getByRole('button', { name: 'First lifecycle start', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(false)
  await expect(first).toHaveCSS('opacity', '1')

  await seek(page, 0)
  await expect(first).toHaveCSS('opacity', '0.4')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(first).toHaveCSS('opacity', '1')
  await expect(page.getByRole('button', { name: 'Second lifecycle', exact: true })).toHaveCSS(
    'opacity',
    '1',
  )
})
