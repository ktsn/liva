import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['src/*.integration.test.ts'],
    // Real dependency installs, WASM builds and browser playback can exceed unit-test limits.
    hookTimeout: 600_000,
    testTimeout: 600_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
})
