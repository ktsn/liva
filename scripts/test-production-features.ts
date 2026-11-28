import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type Plugin } from 'vite-plus'
import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import liva from '../packages/vite/dist/index.js'

const fixture = new URL('../packages/bundle-size/fixture/', import.meta.url)
const optional = {
  reactive: ['/reactive-call-store.js', '/sources-execution.js'],
  builtins: [
    '/builtins/drag.js',
    '/builtins/interaction.js',
    '/builtins/link.js',
    '/builtins/measure.js',
    '/builtins/timeout.js',
  ],
  presence: [
    '/presence-execution.js',
    '/presence-operation.js',
    '/presence-bindings.js',
    '/vue/dist/presence.js',
  ],
  layout: [
    '/layout-execution.js',
    '/layout-write-phase.js',
    '/layout-coordinator.js',
    '/projection-read.js',
    '/style-correction.js',
  ],
  controllers: [
    '/controllers-execution.js',
    '/controller-addresses.js',
    '/controller-presentation.js',
  ],
  spring: ['/spring.js', '/spring-motion.js'],
  inspection: ['/inspection.js', '/preview-execution.js'],
}

interface Variant {
  readonly motion?: string
  readonly includes: readonly string[]
  readonly preserveSymlinks?: boolean
  readonly entry?: 'compiled' | 'full' | 'named'
}

const variants: Record<string, Variant> = {
  'tween only': { includes: [] },
  'measure without projection': {
    motion: `motion fade(active: boolean) {
      let bounds = measure(target: button)
      layer base { button { opacity: \${bounds.width / 1000} } }
    }`,
    includes: [...optional.reactive, '/builtins/measure.js', '/layout-bounds.js'],
  },
  'link without spring': {
    motion: `motion fade(active: boolean) {
      layer base { button { translate := link(input: 10, component: "x") } }
    }`,
    includes: [...optional.reactive, ...optional.controllers, '/builtins/link.js'],
  },
  'tween layout without spring': {
    motion: `motion fade(active: boolean) {
      @tween(duration: 200)
      layer base { button { $layout: position } }
    }`,
    includes: optional.layout,
  },
  'layout with preserved symlinks': {
    motion: `motion fade(active: boolean) {
      @tween(duration: 200, easing: linear)
      layer base { button { $layout: position } }
    }`,
    includes: optional.layout,
    preserveSymlinks: true,
  },
  'direct compiled layout with preserved symlinks': {
    motion: `motion fade(active: boolean) {
      @tween(duration: 200, easing: linear)
      layer base { button { $layout: position } }
    }`,
    includes: optional.layout,
    preserveSymlinks: true,
    entry: 'compiled',
  },
  'named full plugin and compiled Motions with preserved symlinks': {
    motion: `motion fade(active: boolean) {
      @tween(duration: 200, easing: linear)
      layer base { button { $layout: position } }
    }`,
    includes: Object.entries(optional).flatMap(([feature, modules]) =>
      feature === 'inspection' ? [] : modules,
    ),
    preserveSymlinks: true,
    entry: 'full',
  },
  'named Vue re-export and compiled Motions with preserved symlinks': {
    motion: `motion fade(active: boolean) {
      @tween(duration: 200, easing: linear)
      layer base { button { $layout: position } }
    }`,
    includes: Object.entries(optional).flatMap(([feature, modules]) =>
      feature === 'inspection' ? [] : modules,
    ),
    preserveSymlinks: true,
    entry: 'named',
  },
  'spring with local Presence': {
    motion: `motion fade(active: boolean) {
      layer base { button { opacity: 1 } }
      @spring(duration: 300)
      enter { button { opacity: 0 } }
    }`,
    includes: [...optional.spring, ...optional.presence],
  },
}

/** Inspect rendered Rolldown modules for each isolated production entry. */
export async function assertProductionFeatures() {
  const root = await mkdtemp(join(tmpdir(), 'liva-production-features-'))

  try {
    await cp(fixture, root, { recursive: true })
    const file = join(root, 'Button.vue')
    const original = await readFile(file, 'utf8')
    const entryFile = join(root, 'main.ts')
    const originalEntry = await readFile(entryFile, 'utf8')

    for (const [name, { motion, includes, preserveSymlinks, entry }] of Object.entries(variants)) {
      await writeFile(
        file,
        motion ? original.replace(/motion fade[\s\S]*?(?=<\/liva>)/, motion + '\n') : original,
      )

      const vueImport = {
        compiled: "import { createCompiledLivaPlugin as factory } from '@liva/vue/compiled'",
        full: "import { createLivaPlugin as factory } from '@liva/vue/runtime'",
        named: "import { createLivaPlugin as factory } from '@liva/vue'",
      }

      await writeFile(
        entryFile,
        entry
          ? originalEntry
              .replace("import liva from '@liva/vue'", vueImport[entry])
              .replace('.use(liva)', '.use(factory())')
          : originalEntry,
      )

      const observe: Plugin = {
        name: 'liva-feature-assertions',
        generateBundle(_options, bundle) {
          const modules = Object.values(bundle).flatMap((chunk) =>
            chunk.type === 'chunk'
              ? Object.entries(chunk.modules)
                  .filter(([, info]) => info.renderedLength > 0)
                  .map(([id]) => id)
              : [],
          )

          assert(
            modules.some((id) => id.endsWith('/browser-executor.js')),
            `${name} should include core`,
          )

          for (const shared of [
            '/evaluation/expression.js',
            '/layout/geometry-animations.js',
            '/execution/browser-executor.js',
          ]) {
            assert.equal(
              modules.filter((id) => id.endsWith(shared)).length,
              1,
              `${name} should include one ${shared}`,
            )
          }

          const layoutWrites = '/layout/layout-write-phase.js'

          assert.equal(
            modules.filter((id) => id.endsWith(layoutWrites)).length,
            includes.includes('/layout-write-phase.js') ? 1 : 0,
            `${name} should share the layout write phase`,
          )

          for (const included of includes) {
            assert(
              modules.some((id) => id.endsWith(included)),
              `${name} should include ${included}`,
            )
          }

          for (const excluded of Object.values(optional)
            .flat()
            .filter((id) => !includes.includes(id))) {
            assert(
              !modules.some((id) => id.endsWith(excluded)),
              `${name} should exclude ${excluded}`,
            )
          }
        },
      }

      const configure = defineConfig(
        {
          envDir: false,
          root,
          logLevel: 'error',
          plugins: [liva(), observe],
          resolve: {
            preserveSymlinks,
          },
          build: {
            target: 'es2023',
            minify: 'oxc',
            write: false,
            rolldownOptions: {
              input: entryFile,
              external: ['vue'],
            },
          },
        },
        { tasks: false },
      )
      const config = await configure({ command: 'build', mode: 'production' })

      await build({ ...config, configFile: false })

      console.log(`Production capabilities passed (${name}).`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
