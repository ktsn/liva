import { defineConfig } from 'vite-plus'
import { playwright } from 'vite-plus/test/browser-playwright'

/** Verifies projection calculations against actual CSSOM/rendering in every supported engine. */
export default defineConfig({
  server: { port: 4195, strictPort: true },
  test: {
    name: 'layout-calculation',
    include: ['packages/runtime/src/layout/{projection,style-correction}.browser.test.ts'],
    fileParallelism: false,
    coverage: { enabled: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
})
