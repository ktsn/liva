import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import VueRouter from 'vue-router/vite'
import liva from '@liva/vite'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite-plus'

const editorWatch: Plugin = {
  name: 'playground-editor-watch',
  enforce: 'pre',
  configureServer(server) {
    const root = fileURLToPath(new URL('../packages/vite/src/editor', import.meta.url))

    // Vize's root-external SFC loads do not register individual files with the watcher.
    server.watcher.add([
      root,
      ...globSync('**/*.{vue,ts,css}', { cwd: root }).map((file) => join(root, file)),
    ])
  },
  hotUpdate({ file, timestamp }) {
    const root = fileURLToPath(new URL('../packages/vite/src/editor/', import.meta.url))

    if (!file.startsWith(root)) return

    // Custom-element styles are inline imports; invalidate them before the SFC reloads.
    for (const module of this.environment.moduleGraph.idToModuleMap.values()) {
      if (module.id?.includes(file) && module.id.includes('type=style')) {
        this.environment.moduleGraph.invalidateModule(module, new Set(), timestamp, true)
      }
    }
  },
}

export default defineConfig(
  {
    plugins: [VueRouter({ dts: false }), liva(), editorWatch],
  },
  { tasks: false },
)
