import { defineConfig } from 'vite-plus'

export default defineConfig({
  optimizeDeps: { entries: ['tests/browser/index.html'] },

  lint: {
    plugins: [
      'oxc',
      'eslint',
      'typescript',
      'unicorn',
      'import',
      'jsdoc',
      'promise',
      'vitest',
      'vue',
    ],

    categories: {
      correctness: 'error',
      suspicious: 'error',
    },

    rules: {
      'eslint/no-underscore-dangle': ['error', { allow: ['__LIVA_EDITOR__'] }],
    },

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
