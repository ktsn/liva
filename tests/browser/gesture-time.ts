import type { Page } from '@playwright/test'

/**
 * Fix performance.now() to a synthetic millisecond timestamp for pointer history
 * (for example, 1000 then 1016 for samples 16ms apart).
 * The value stays fixed until the next call or page disposal; timers, RAF and
 * native animations keep running so release animations can settle normally.
 */
export async function setGestureTime(page: Page, time: number) {
  await page.evaluate((timestamp) => {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => timestamp })
  }, time)
}
