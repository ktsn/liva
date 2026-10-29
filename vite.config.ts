import { defineConfig } from 'vite-plus'

export default defineConfig({
  optimizeDeps: { entries: ['tests/browser/index.html'] },

  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },

  fmt: {
    semi: false,
    singleQuote: true,
    ignorePatterns: ['Cargo.lock'],
  },

  test: {
    include: ['packages/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
