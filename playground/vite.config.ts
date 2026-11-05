import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import VueRouter from 'vue-router/vite'
import liva from '@liva/vite'

export default defineConfig({ plugins: [VueRouter({ dts: false }), liva()] }, { tasks: false })
