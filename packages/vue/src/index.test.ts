import { expect, it, vi } from 'vite-plus/test'
import { createApp } from 'vue'
import liva, { createLivaPlugin } from '@liva/vue'
import { createLivaPlugin as createRuntimePlugin } from '@liva/vue/runtime'

it("exports a usable package plugin without Vite's virtual module resolver", () => {
  const app = createApp({})
  const register = vi.spyOn(app, 'directive')

  app.use(liva)

  expect(app.directive('liva')).toBeDefined()
  expect(app.directive('liva-target')).toBeDefined()
  expect(
    register.mock.calls
      .filter((call) => call.length === 2)
      .map(([name]) => name)
      .toSorted(),
  ).toEqual(['liva', 'liva-entry', 'liva-target'])
  expect(createLivaPlugin).toBe(createRuntimePlugin)
})
