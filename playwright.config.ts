import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  // HMR tests edit source files shared by every browser and page.
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4179' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'vp dev --host 127.0.0.1 --port 4179 --strictPort',
      url: 'http://127.0.0.1:4179/tests/browser/',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'cd playground && vp dev --host 127.0.0.1 --port 4180 --strictPort',
      url: 'http://127.0.0.1:4180',
      reuseExistingServer: !process.env.CI,
    },
  ],
})
