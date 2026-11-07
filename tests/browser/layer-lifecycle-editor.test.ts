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

async function expectCapturedStart(page: Page, value: string) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...window.__LIVA_EDITOR__.entries.values()].map(({ binding }) => {
          const composition = binding.runtime.composition

          if (!composition) throw new Error('Missing lifecycle composition')

          return binding.runtime
            .inspectLifecycle('enter', composition)
            .transition?.targets.find((target) => target.name === 'body')
            ?.properties.find((property) => property.name === 'opacity')
            ?.keyframes?.find((frame) => frame.offset === 0)?.value
        }),
      ),
    )
    .toEqual([value, value])
}

for (const phase of ['enter', 'leave']) {
  test(`${phase} retains rows for lifecycle-only targets`, async ({ page }) => {
    await open(page)
    await page.getByLabel('Existing transition').selectOption(`${phase}-default`)
    await page.getByRole('button', { name: 'Toggle badge tracks', exact: true }).click()

    await expect(page.getByLabel('Select badge.opacity', { exact: true })).toBeVisible()
  })
}

test('composition lifecycle previews isolate the selected instance', async ({ page }) => {
  await open(page)
  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })
  const second = page.getByRole('button', { name: 'Second lifecycle', exact: true })

  await page.getByLabel('Existing transition').selectOption('enter-default')
  await page.getByLabel('Baseline active enabled', { exact: true }).check()
  await seek(page, 100)

  await expect(first).toHaveCSS('opacity', '0.5')
  await expect(second).toHaveCSS('opacity', '1')
  await expect(first).toHaveAttribute('aria-pressed', 'false')
})

test('leave scrubs bidirectionally without removing the DOM and restores the application', async ({
  page,
}) => {
  await open(page)
  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })

  await page.getByLabel('Existing transition').selectOption('leave-default')
  await page.getByLabel('Baseline active enabled', { exact: true }).check()
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
    await page.getByLabel('Existing transition').selectOption('enter-default')
    await page.getByRole('button', { name: 'Toggle body tracks', exact: true }).click()
    await page.getByRole('button', { name: 'body.opacity 0%', exact: true }).click()
    await page.getByLabel('Keyframe source value', { exact: true }).fill('${start * 2}')
    await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()

    await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.previewActive)).toBe(true)

    await seek(page, 0)

    await expect(page.getByRole('button', { name: 'First lifecycle', exact: true })).toHaveCSS(
      'opacity',
      '0.4',
    )

    await page.getByRole('button', { name: 'Save to source', exact: true }).click()

    await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.message)).toContain('Saved')
    await expectCapturedStart(page, '0.4')

    for (const label of ['First lifecycle', 'Second lifecycle']) {
      const option = page
        .getByLabel('Preview instance', { exact: true })
        .getByRole('option', { name: new RegExp(label) })
      const id = await option.getAttribute('value')

      if (!id) throw new Error(`Missing preview instance: ${label}`)

      await page.getByLabel('Preview instance', { exact: true }).selectOption(id)
      await page.getByLabel('Existing transition').selectOption('enter-default')
      await seek(page, 0)

      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCSS(
        'opacity',
        '0.4',
      )
    }

    const saved = await readFile(file, 'utf8')

    expect(saved).toContain('0%: ${start * 2}')
    expect(saved).toContain('@tween(duration: 200, easing: linear) enter')
    expect(saved.slice(0, saved.indexOf('<liva'))).toBe(
      original.slice(0, original.indexOf('<liva')),
    )
  } finally {
    await writeFile(file, original)

    await expectCapturedStart(page, '0.2')
  }
})

test('application inputs end lifecycle preview and the next preview captures updated expressions', async ({
  page,
}) => {
  await open(page)
  const first = page.getByRole('button', { name: 'First lifecycle', exact: true })

  await page.getByLabel('Existing transition').selectOption('enter-default')
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
