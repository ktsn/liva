import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type Plugin } from 'vite-plus'
import { defineConfig } from '@vizejs/vite-plugin/vite-plus'
import liva from '../packages/vite/src/index.ts'

const fixture = new URL('../packages/bundle-size/fixture/', import.meta.url)
const optional = {
  reactive: ['/reactive-call-store.ts', '/sources-execution.ts'],
  builtins: [
    '/builtins/drag.ts',
    '/builtins/interaction.ts',
    '/builtins/link.ts',
    '/builtins/measure.ts',
    '/builtins/timeout.ts',
  ],
  presence: [
    '/presence-execution.ts',
    '/presence-operation.ts',
    '/presence-bindings.ts',
    '/vue/src/presence.ts',
  ],
  layout: [
    '/layout-execution.ts',
    '/layout-write-phase.ts',
    '/layout-coordinator.ts',
    '/projection-read.ts',
    '/style-correction.ts',
  ],
  controllers: [
    '/controllers-execution.ts',
    '/controller-addresses.ts',
    '/controller-presentation.ts',
  ],
  spring: ['/spring.ts', '/spring-motion.ts'],
  inspection: ['/inspection.ts', '/preview-execution.ts'],
}

interface Variant {
  readonly motion?: string
  readonly includes: readonly string[]
  readonly preserveSymlinks?: boolean
  readonly directVue?: boolean
}

const variants: Record<string, Variant> = {
  'tween only': { includes: [] },
  'measure without projection': {
    motion: `motion fade(active: boolean) {
      let bounds = measure(target: button)
      layer base { button { opacity: \${bounds.width / 1000} } }
    }`,
    includes: [...optional.reactive, '/builtins/measure.ts', '/layout-bounds.ts'],
  },
  'link without spring': {
    motion: `motion fade(active: boolean) {
      layer base { button { translate := link(input: 10, component: "x") } }
    }`,
    includes: [...optional.reactive, ...optional.controllers, '/builtins/link.ts'],
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
    directVue: true,
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
    const entry = join(root, 'main.ts')
    const originalEntry = await readFile(entry, 'utf8')

    for (const [name, { motion, includes, preserveSymlinks, directVue }] of Object.entries(
      variants,
    )) {
      if (motion)
        await writeFile(file, original.replace(/motion fade[\s\S]*?(?=<\/liva>)/, motion + '\n'))

      await writeFile(
        entry,
        directVue
          ? originalEntry
              .replace(
                "import liva from '@liva/vue'",
                "import { createCompiledLivaPlugin } from '@liva/vue/compiled'",
              )
              .replace('.use(liva)', '.use(createCompiledLivaPlugin())')
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
            modules.some((id) => id.endsWith('/browser-executor.ts')),
            `${name} should include core`,
          )

          for (const shared of ['/evaluation/expression.ts', '/layout/geometry-animations.ts']) {
            assert.equal(
              modules.filter((id) => id.endsWith(shared)).length,
              1,
              `${name} should include one ${shared}`,
            )
          }

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
      const resolveVueRuntime = new URL('../packages/vue/src/runtime.ts', import.meta.url).pathname

      const configure = defineConfig(
        {
          envDir: false,
          root,
          logLevel: 'error',
          plugins: [liva(), observe],
          resolve: {
            alias: [{ find: '@liva/vue/runtime', replacement: resolveVueRuntime }],
            preserveSymlinks,
          },
          build: {
            target: 'es2023',
            minify: 'oxc',
            write: false,
            rolldownOptions: {
              input: entry,
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
