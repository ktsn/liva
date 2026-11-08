import { expect, test, type Locator } from '@playwright/test'

const base = 'http://127.0.0.1:4180'
const times = [0, 1, 44, 120, 239, 240, 299, 300]
const outcomes = [
  { value: 'success', status: 'Saved', label: '· Saved ✓', transition: 3 },
  { value: 'error', status: 'Request failed', label: '· Failed — try again', transition: 4 },
] as const

async function visibleFeedback(button: Locator) {
  return button
    .locator('span')
    .evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => element.textContent?.trim()),
    )
}

async function sampleStatusTransition(button: Locator, status: string) {
  return button.evaluate(
    (element, { status: expectedStatus, times: sampleTimes }) =>
      new Promise<string[][]>((resolve, reject) => {
        const statusElement = document.querySelector('[role="status"]')
        // Capture at the status update so a brief overlap cannot settle before sampling.
        const observer = new MutationObserver(capture)

        function capture() {
          if (statusElement?.textContent?.trim() !== expectedStatus) return

          observer.disconnect()
          const animations = element.getAnimations({ subtree: true })
          if (animations.length === 0) {
            reject(new Error('Expected active submit transition animations'))
            return
          }

          // Seek native effects synchronously instead of racing wall-clock delays.
          for (const animation of animations) animation.pause()
          const samples = sampleTimes.map((time) => {
            for (const animation of animations) animation.currentTime = time

            return [...element.querySelectorAll('span')]
              .filter((label) => getComputedStyle(label).display !== 'none')
              .map((label) => label.textContent?.trim() ?? '')
          })

          for (const animation of animations) animation.finish()
          resolve(samples)
        }

        if (!statusElement) {
          reject(new Error('Expected submit status element'))
          return
        }

        observer.observe(statusElement, { subtree: true, childList: true, characterData: true })
        capture()
      }),
    { status, times },
  )
}

for (const outcome of outcomes) {
  test(`async submit keeps only the current label during ${outcome.value} completion and retry`, async ({
    page,
  }) => {
    await page.goto(`${base}/async-submit`)
    const button = page.getByTestId('submit')
    await page.getByTestId('submit-outcome').selectOption(outcome.value)

    await button.click()
    const completion = await sampleStatusTransition(button, outcome.status)

    for (const labels of completion) expect(labels).toEqual([outcome.label])

    await button.click()
    const retry = await sampleStatusTransition(button, 'Saving…')

    for (const labels of retry) expect(labels).toEqual(['· Sending…'])
  })

  test(`async submit editor preview keeps labels exclusive throughout pending to ${outcome.value}`, async ({
    page,
  }) => {
    await page.goto(`${base}/async-submit`)
    const button = page.getByTestId('submit')
    await page.getByRole('button', { name: 'Motion editor', exact: true }).click()
    await expect(page.getByLabel('Playhead')).toBeVisible()
    await page
      .getByLabel('Existing transition')
      .selectOption(JSON.stringify({ layer: 'request', index: outcome.transition }))

    for (const time of times) {
      await page.getByLabel('Playhead').evaluate((element, position) => {
        if (!(element instanceof HTMLInputElement)) throw new Error('Expected playhead input')
        element.value = String(position)
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }, time)

      await expect.poll(() => visibleFeedback(button)).toEqual([outcome.label])
    }
  })
}
