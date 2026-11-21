import { resolve } from 'node:path'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: ['src/__tests__/*.integration.test.ts'],
    // Real dependency installs and WASM builds can exceed unit-test limits.
    hookTimeout: 600_000,
    testTimeout: 600_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
})
