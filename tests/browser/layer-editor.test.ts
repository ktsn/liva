import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../../playground/src/Toggle.vue', import.meta.url)
const base = 'http://127.0.0.1:4180'

test.describe.configure({ mode: 'serial' })

async function openProperty(page: Page) {
  await page.goto(`${base}/toggle`)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle track tracks' }).click()
  await page.getByLabel('Select track.background-color', { exact: true }).click()
}

async function expectMessage(page: Page, message: string) {
  await expect.poll(() => page.evaluate(() => window.__LIVA_EDITOR__.message)).toContain(message)
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save to source', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save to source', exact: true })).toBeDisabled()
  await expectMessage(page, 'Saved')
}

test('the inspector follows the selected endpoint declaration', async ({ page }) => {
  await page.goto(`${base}/interactive-button`)
  await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
  await page.getByLabel('To hover enabled', { exact: true }).check()
  await page.getByRole('button', { name: 'Toggle body tracks', exact: true }).click()

  const inspector = page.getByLabel('Selection inspector', { exact: true })

  for (const { offset, layer, value } of [
    { offset: 0, layer: 'base', value: '#d9f3e8' },
    { offset: 100, layer: 'hover', value: '#b5e4d1' },
  ]) {
    await page
      .getByRole('button', { name: `body.background-color ${offset}%`, exact: true })
      .click()

    await expect(inspector.getByLabel('Editing location', { exact: true })).toHaveText(
      `Layer: ${layer}`,
    )
    await expect(inspector.getByLabel('Source value', { exact: true })).toHaveValue(value)
    await expect(inspector.getByLabel('Source value', { exact: true })).toHaveCount(1)
    await expect(inspector).not.toContainText('From')
    await expect(inspector).not.toContainText('To')
  }
})

test('layer value previews remain isolated until save propagates through HMR', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const original = await readFile(file, 'utf8')

  try {
    await openProperty(page)
    const first = page.getByRole('switch', { name: 'Notifications', exact: true })
    const second = page.getByRole('switch', { name: 'Product updates', exact: true })

    await expect(page.getByLabel('Source value', { exact: true })).toHaveValue('#888')
    await page.getByLabel('Source value', { exact: true }).fill('#553399')
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
    await expectMessage(page, 'Previewing')

    await expect(first).toHaveCSS('background-color', 'rgb(85, 51, 153)')
    await expect(second).toHaveCSS('background-color', 'rgb(136, 136, 136)')
    expect(await readFile(file, 'utf8')).toBe(original)

    await save(page)

    await expect(second).toHaveCSS('background-color', 'rgb(85, 51, 153)')
    expect(await readFile(file, 'utf8')).toBe(
      original.replace('background-color: #888', 'background-color: #553399'),
    )
  } finally {
    await writeFile(file, original)
  }
})

for (const expression of [
  'spring(duration: 400, bounce: 0.25)',
  'tween(duration: 400, easing: steps(count: 4, position: "jump-end"))',
]) {
  test(`typed local timing round-trips ${expression}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Shared source writes run once')
    const original = await readFile(file, 'utf8')

    try {
      await openProperty(page)
      await page.getByLabel('Timing expression', { exact: true }).fill(expression)
      await page.getByRole('button', { name: 'Apply timing expression', exact: true }).click()
      await expectMessage(page, 'Previewing')
      await save(page)

      const saved = await readFile(file, 'utf8')

      expect(saved).toContain(`background-color: #888 @${expression}`)
      expect(saved).toContain('track @tween(duration: 200, easing: easeInOut)')
      expect(saved).toContain('thumb @spring(stiffness: 300, damping: 20)')
    } finally {
      await writeFile(file, original)
    }
  })
}

test('ordinary property keyframes preserve the destination and typed easing on save', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const original = await readFile(file, 'utf8')

  try {
    await openProperty(page)
    await page.getByLabel('Playhead', { exact: true }).evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('Expected playhead')
      element.value = '100'
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expectMessage(page, 'Previewing')
    await page.getByRole('button', { name: 'New keyframe at playhead', exact: true }).click()
    await page.getByLabel('Keyframe source value', { exact: true }).fill('purple')
    await page.getByLabel('Keyframe easing expression', { exact: true }).fill('stepStart')
    await page.getByRole('button', { name: 'Add keyframe', exact: true }).click()
    await expectMessage(page, 'Previewing')
    await save(page)

    const saved = await readFile(file, 'utf8')

    expect(saved).toContain('50%: purple @ stepStart')
    expect(saved).toContain('100%: #888')
    expect(saved).toContain('track @tween(duration: 200, easing: easeInOut)')
  } finally {
    await writeFile(file, original)
  }
})

test('added and moved keyframes remain selected for subsequent edits and deletion', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Shared source writes run once')
  const original = await readFile(file, 'utf8')

  try {
    await openProperty(page)
    await page.getByRole('button', { name: 'New keyframe at playhead', exact: true }).click()
    await page.getByLabel('Keyframe percentage', { exact: true }).fill('33.333')
    await page.getByLabel('Keyframe source value', { exact: true }).fill('purple')
    await page.getByRole('button', { name: 'Add keyframe', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Apply keyframe', exact: true })).toBeVisible()

    await page.getByLabel('Keyframe percentage', { exact: true }).fill('60')
    await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
    await expect(page.getByLabel('Selected keyframe', { exact: true })).toContainText('60%')
    await page.getByLabel('Keyframe source value', { exact: true }).fill('orange')
    await page.getByRole('button', { name: 'Apply keyframe', exact: true }).click()
    await expect(page.getByLabel('Selected keyframe', { exact: true })).toContainText('orange')

    await page.getByRole('button', { name: 'Delete keyframe', exact: true }).click()
    await expect(page.getByLabel('Keyframe source value', { exact: true })).toHaveCount(0)
    await save(page)

    const saved = await readFile(file, 'utf8')

    expect(saved).not.toContain('60%:')
    expect(saved).not.toContain('33.333')
    expect(saved).toContain('100%: #888')
  } finally {
    await writeFile(file, original)
  }
})
