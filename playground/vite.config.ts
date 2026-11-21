import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import VueRouter from 'vue-router/vite'
import liva from '@liva/vite'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePath, type Plugin } from 'vite-plus'

const editorRoot = new URL('../packages/vite/src/editor/', import.meta.url)
const editorWatch: Plugin = {
  name: 'playground-editor-watch',
  enforce: 'pre',
  configureServer(server) {
    const root = fileURLToPath(editorRoot)

    // Vize's root-external SFC loads do not register individual files with the watcher.
    server.watcher.add([
      root,
      ...globSync('**/*.{vue,ts,css}', { cwd: root }).map((file) => join(root, file)),
    ])
  },
  hotUpdate({ file, timestamp }) {
    if (!file.startsWith(normalizePath(fileURLToPath(editorRoot)))) return

    // Custom-element styles are inline imports; invalidate them before the SFC reloads.
    for (const module of this.environment.moduleGraph.idToModuleMap.values()) {
      if (module.id?.includes(file) && module.id.includes('type=style')) {
        this.environment.moduleGraph.invalidateModule(module, new Set(), timestamp, true)
      }
    }
  },
}

export default defineConfig(
  ({ command, mode }) => {
    const plugins = [VueRouter({ dts: false }), liva()]

    if (command !== 'serve' || mode !== 'editor-source') return { plugins }

    return {
      plugins: [...plugins, editorWatch],
      cacheDir: 'node_modules/.vite-editor-source',
      resolve: {
        alias: {
          'virtual:liva-editor': fileURLToPath(new URL('client.ts', editorRoot)),
        },
      },
    }
  },
  { tasks: false },
)
