import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import liva from '@liva/vite'

export default defineConfig({ plugins: [liva()] }, { tasks: false })
