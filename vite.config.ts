import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import { defineConfig as defineViteConfig } from 'vite-plus'
import { playwright } from 'vite-plus/test/browser-playwright'
import { configDefaults } from 'vite-plus/test/config'

const nativeInteractionTests = ['packages/runtime/src/builtins/interaction.browser.test.ts']

const config = defineViteConfig({
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
      denyWarnings: true,
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
    maxWorkers: process.env.CI ? 2 : undefined,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            'packages/**/*.browser.test.ts',
            'packages/**/*.cross-browser.test.ts',
          ],
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
          fileParallelism: true,
          include: ['packages/**/*.browser.test.ts'],
          exclude: [...configDefaults.exclude, ...nativeInteractionTests],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'browser-interaction',
          include: nativeInteractionTests,
          // Other test pages must finish before observing native focus and hover changes.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'cross-browser',
          fileParallelism: true,
          include: ['packages/**/*.cross-browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium', name: 'cross-browser-chromium' },
              { browser: 'firefox', name: 'cross-browser-firefox' },
              { browser: 'webkit', name: 'cross-browser-webkit' },
            ],
          },
        },
      },
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['packages/**/*.{ts,vue}'],
      exclude: [
        'packages/**/*.test.ts',
        'packages/**/__test__/**',
        'packages/**/*.d.ts',
        'packages/**/wasm/**',
      ],
      thresholds: { 100: true, perFile: true },
    },
  },
})

export default defineConfig({
  ...config,
  vue: {
    linter: {
      maxWarnings: 0,
      reportUnusedDisableDirectives: true,
      rules: {
        // Props objects and template-only declarations are supported alongside destructuring.
        'script/define-props-destructuring': 'off',
      },
      categories: {
        correctness: 'error',
        suspicious: 'error',
        style: 'error',
        perf: 'error',
        a11y: 'error',
        security: 'error',
      },
    },
    entries: [
      {
        files: ['**/*.ce.vue'],
        linter: {
          // The .ce suffix enables Vue custom-element style injection.
          rules: { 'vue/component-definition-name-casing': 'off' },
        },
      },
    ],
  },
})
