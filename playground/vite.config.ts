import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import VueRouter from 'vue-router/vite'
import { globSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePath, type Plugin } from 'vite-plus'
import sourceConfig from '../tsconfig.sources.json' with { type: 'json' }

const { paths } = sourceConfig.compilerOptions
const workspace = new URL('../', import.meta.url)
const runtimeSource = new URL(paths['@liva/runtime'][0], workspace)
const viteEntry = new URL(paths['@liva/vite'][0], workspace)
const viteSource = new URL('./', viteEntry)
const editorRoot = new URL('editor/', viteEntry)
const require = createRequire(import.meta.url)

function loadLivaPlugin(source: boolean) {
  const entry = source ? fileURLToPath(viteEntry) : '@liva/vite'

  // Vite's browser aliases only apply after Node has loaded the compiler plugin.
  const hooks = source
    ? registerHooks({
        resolve(id, context, nextResolve) {
          if (id === '@liva/runtime' && context.parentURL?.startsWith(viteSource.href))
            return nextResolve(runtimeSource.href, context)

          return nextResolve(id, context)
        },
      })
    : undefined

  try {
    const { default: liva }: { default: () => Plugin } = require(entry)
    return liva()
  } finally {
    hooks?.deregister()
  }
}

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
  ({ command, isPreview }) => {
    const source = command === 'serve' && !isPreview
    const plugins = [VueRouter({ dts: false }), loadLivaPlugin(source)]

    if (!source) return { plugins }

    return {
      plugins: [...plugins, editorWatch],
      resolve: {
        alias: {
          '@liva/runtime': fileURLToPath(runtimeSource),
          '@liva/vue/runtime': fileURLToPath(new URL(paths['@liva/vue/runtime'][0], workspace)),
          'virtual:liva-editor': fileURLToPath(new URL('client.ts', editorRoot)),
        },
      },
    }
  },
  { tasks: false },
)
