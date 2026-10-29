import { expect, it } from 'vite-plus/test'
import { createApp } from 'vue'
import liva, { createLivaPlugin } from '@liva/vue'
import { createLivaPlugin as createRuntimePlugin } from '@liva/vue/runtime'

it("exports a usable package plugin without Vite's virtual module resolver", () => {
  const app = createApp({})

  app.use(liva)

  expect(app.directive('liva')).toBeDefined()
  expect(app.directive('liva-target')).toBeDefined()
  expect(createLivaPlugin).toBe(createRuntimePlugin)
})
