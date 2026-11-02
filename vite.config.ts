import { defineConfig } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import { playwright } from 'vite-plus/test/browser-playwright'

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    entries: ['tests/browser/index.html'],
    include: ['vite-plus/test/browser'],
  },

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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [
          {
            name: 'liva-test-editor-events',
            configureServer(server) {
              server.ws.on('liva:test:events', () => {
                server.ws.send({
                  type: 'custom',
                  event: 'liva:source-changed',
                  data: { sourceId: 'source' },
                })
                server.ws.send({
                  type: 'custom',
                  event: 'liva:diagnostics',
                  data: { diagnostics: [] },
                })
                server.ws.send({
                  type: 'custom',
                  event: 'liva:diagnostics',
                  data: {
                    sourceId: 'source',
                    diagnostics: [{ message: 'First' }, { message: 'Second' }],
                  },
                })
              })
            },
          },
        ],
        test: {
          name: 'browser',
          fileParallelism: false,
          include: ['packages/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],

  },
})
