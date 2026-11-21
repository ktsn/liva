import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const base = 'http://127.0.0.1:4180/tests/presence-assets.html'

async function removeFirstItem(page: Page) {
  const first = page.getByText('First item', { exact: true })
  const remove = page.getByRole('button', { name: 'Remove first item' })
  const row = await first.elementHandle()
  const leaving = await remove.evaluateHandle(
    (button, element) => ({
      started: new Promise<boolean>((resolve) => {
        button.addEventListener(
          'click',
          () => {
            queueMicrotask(() => resolve(element.isConnected && element.getAnimations().length > 0))
          },
          { once: true },
        )
      }),
    }),
    row,
  )

  try {
    await remove.click()

    expect(await leaving.evaluate(({ started }) => started)).toBe(true)
    await expect(first).toHaveCount(0)
    await expect(page.getByText('Second item', { exact: true })).toBeVisible()
  } finally {
    await leaving.dispose()
    await row.dispose()
  }
}

test('retains a leaving row beside its author-registered component', async ({ page }) => {
  await page.goto(base + '?fixture=registry')
  const authored = page.getByTestId('authored-component')
  const row = page.getByText('First item', { exact: true })

  await expect(authored).toHaveText('Author-registered component')
  await expect(row).toHaveAttribute('title', 'Authored attributes')
  await expect(row).toHaveAttribute('data-authored-mount', 'true')

  await removeFirstItem(page)

  await expect(authored).toBeVisible()
})

test('retains leave with an authored custom-block attribute', async ({ page }) => {
  await page.goto(base + '?fixture=attribute')

  await removeFirstItem(page)
})

test('retains Presence after a template hot update contains the old generated name', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'A shared source-writing HMR transaction runs once')
  const file = new URL('../../playground/tests/PresenceHot.vue', import.meta.url)
  const original = await readFile(file, 'utf8')
  const errors: string[] = []

  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text())
  })

  try {
    await page.goto(base + '?fixture=hot')
    const counter = page.getByRole('button', { name: /^Count/ })
    await counter.click()
    await expect(counter).toHaveText('Count 1')
    const originalCounter = await counter.elementHandle()
    const edited = original.replace(
      '<main title="Before edit">',
      '<main title="After edit">\n    <!-- LivaCompiledPresenceBoundary -->',
    )

    await writeFile(file, edited)

    await expect(page.getByRole('main')).toHaveAttribute('title', 'After edit')
    await expect(counter).toHaveText('Count 1')
    expect(await originalCounter.evaluate((element) => element.isConnected)).toBe(true)
    await originalCounter.dispose()

    await removeFirstItem(page)

    expect(errors).toEqual([])
  } finally {
    await writeFile(file, original)
  }
})
