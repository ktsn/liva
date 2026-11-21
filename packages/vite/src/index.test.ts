import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import liva from './index.ts'
import type { Plugin } from 'vite-plus'

let root: string
let file: string
let source: string
let block: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'liva-plugin-'))
  file = join(root, 'Toggle.vue')
  block = await readFile(new URL('../../../fixtures/toggle.liv', import.meta.url), 'utf8')
  source = `<template><div /></template><liva>${block}</liva>`
  await writeFile(file, source)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function hooks(plugin = liva()) {
  const warnings: unknown[] = []
  const resolve = vi.fn<(specifier: string, importer: string) => Promise<{ id: string } | null>>(
    async (id) => ({ id }),
  )
  const context = {
    resolve,
    error(error: { message: string }) {
      throw new Error(error.message)
    },
    warn(warning: unknown) {
      warnings.push(warning)
    },
  }

  function call(name: keyof Plugin, ...args: unknown[]): any {
    const hook = plugin[name]

    return (typeof hook === 'function' ? hook : hook.handler).apply(context, args)
  }

  return { call, warnings, resolve }
}

function development(call: ReturnType<typeof hooks>['call']) {
  const events: unknown[] = []

  call('configureServer', {
    config: { root, server: {} },
    middlewares: { use() {} },
    ws: {
      send(event: unknown) {
        events.push(event)
      },
    },
  })

  return events
}

describe('Vite compilation hooks', () => {
  it('resolves feature imports from the same entry as Vue core', async () => {
    const { call, resolve } = hooks()
    const compiled = '/packages/vue/src/compiled.ts'
    resolve.mockResolvedValueOnce({ id: compiled }).mockResolvedValueOnce({ id: compiled })

    expect(call('config')).toEqual({ optimizeDeps: { exclude: ['@liva/vue'] } })
    expect(await call('resolveId', '@liva/vue')).toBe('\0liva:vue-plugin')
    expect(await call('resolveId', '@liva/vue/compiled')).toEqual({ id: compiled })
    await call('resolveId', 'liva:runtime/motion/spring-playback')

    expect(resolve.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      '@liva/runtime/features/motion/spring-playback',
      compiled,
    ])
    await call('resolveId', 'liva:vue/presence')
    expect(resolve.mock.calls.at(-1)?.[0]).toBe('@liva/vue/features/presence')

    expect(await call('resolveId', 'virtual:liva-editor')).toBeNull()
    expect(await call('resolveId', './other')).toBeNull()
    expect(call('load', './other')).toBeNull()
    expect(call('load', '\0liva:vue-plugin')).toContain('createCompiledLivaPlugin()')
  })

  it('reports the missing Vue entry when its runtime features cannot be anchored', async () => {
    const { call, resolve } = hooks()
    resolve.mockImplementationOnce(async () => null)

    await expect(call('resolveId', 'liva:runtime/model/definition')).rejects.toThrow(
      'Could not resolve the compiled Liva Vue entry',
    )
  })

  it('compiles custom blocks, reuses unchanged sources and skips other queries', async () => {
    const { call } = hooks()

    for (const id of [
      'file.ts',
      `${file}?vue&type=template`,
      `${file}?type=liva`,
      `${file}?vue&vize&type=template`,
      ...['raw', 'url', 'worker', 'sharedworker'].map((query) => `${file}?${query}`),
      `${file}?vue&type=liva&raw`,
    ]) {
      expect(await call('transform', source, id)).toBeUndefined()
    }

    expect(await call('transform', '<template><div /></template>', file)).toBeUndefined()
    expect(await call('transform', source, file)).toMatchObject({ code: source })
    for (const query of ['vue', 'vue&vize', 'component=true']) {
      expect(await call('transform', source, `${file}?${query}`)).toMatchObject({ code: source })
    }

    const first = await call('transform', block, `${file}?vue&type=liva`)

    expect(first.code).toContain('decodeBundle')
    expect(first.code).toContain('toggle')
    expect(first.code).not.toContain('livaSource')
    expect(await call('transform', block, `${file}?vue&type=liva`)).toEqual(first)
  })

  it('preprocesses supplied SFC source and compiles supplied blocks without rereading the file', async () => {
    const { call } = hooks()
    await writeFile(file, '<template><div /></template><liva>motion {</liva>')

    expect(await call('transform', source, `${file}?component=true`)).toMatchObject({
      code: source,
    })

    const replacement = 'motion replacement { layer idle { box { opacity: 1 } } }'
    const transformed = await call('transform', replacement, `${file}?vue&type=liva&index=0`)
    expect(transformed.code).toContain('replacement')
    expect(transformed.code).not.toContain('toggle')

    await rm(file)

    expect(await call('transform', replacement, `${file}?vue&type=liva&index=0`)).toEqual(
      transformed,
    )
    expect((await call('transform', block, `${file}?vue&type=liva&index=0`)).code).toContain(
      'toggle',
    )
  })

  it('rejects duplicate and external blocks while preprocessing the whole SFC', async () => {
    const { call } = hooks()

    for (const blocks of [
      '<liva>motion a {}</liva><liva>motion b {}</liva>',
      '<liva src="a.liv" />',
    ]) {
      await expect(
        call('transform', `<template><div /></template>${blocks}`, file),
      ).rejects.toThrow('Expected exactly one inline <liva> block')
    }
  })

  it('rejects compilation errors in production', async () => {
    const { call } = hooks()
    const invalid = '<template><div /></template><liva>motion {</liva>'

    await writeFile(file, invalid)
    block = 'motion {'

    await expect(call('transform', invalid, file)).rejects.toThrow(/expected|Expected/)
    await expect(call('transform', block, `${file}?vue&type=liva`)).rejects.toThrow(
      /expected|Expected/,
    )
  })

  it('retains the last valid development compilation and reports hot-update diagnostics', async () => {
    const { call, warnings } = hooks()
    const events = development(call)

    expect(call('resolveId', 'virtual:liva-editor')).toMatch(/\/editor\.js$/)
    expect(call('load', '\0liva:vue-plugin')).toContain('import.meta.hot')

    await call('transform', source, file)
    const first = await call('transform', block, `${file}?vue&type=liva`)

    expect(first.code).toContain('livaSource')

    const invalid = '<template><div /></template><liva>motion {</liva>'

    await writeFile(file, invalid)
    block = 'motion {'

    expect(await call('transform', invalid, file)).toMatchObject({ code: invalid })
    expect((await call('transform', block, `${file}?vue&type=liva`)).code).toBe(first.code)
    expect(warnings).toHaveLength(1)
    expect(await call('handleHotUpdate', { file, read: async () => invalid })).toEqual([])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'liva:diagnostics' }),
        expect.objectContaining({ event: 'liva:source-changed' }),
      ]),
    )

    await writeFile(file, source)

    expect(await call('handleHotUpdate', { file, read: async () => source })).toBeUndefined()
    expect(await call('handleHotUpdate', { file: 'other.ts' })).toBeUndefined()
    expect(
      await call('handleHotUpdate', { file, read: async () => '<template><div /></template>' }),
    ).toBeUndefined()
  })

  it('reports unreadable source paths during hot updates', async () => {
    const { call } = hooks()
    const events = development(call)

    expect(
      await call('handleHotUpdate', { file: join(root, 'Missing.vue'), read: async () => source }),
    ).toEqual([])
    expect(events).toEqual([expect.objectContaining({ event: 'liva:diagnostics' })])
  })
})

it('reports presence ownership conflicts with the source location', async () => {
  const { call } = hooks()
  const conflict =
    '<template><div v-liva:fade><Transition><div v-if="shown" v-liva-target:box /></Transition></div></template><liva>motion fade { layer idle { box { opacity: 1 } } @tween(duration: 100) enter { box { opacity ~> { 0%: 0 } } } }</liva>'

  await writeFile(file, conflict)

  await expect(call('transform', conflict, file)).rejects.toThrow('Vue Transition conflicts')
})

it('does not invent a fallback compilation for an initially invalid development source', async () => {
  const { call } = hooks()

  development(call)

  const invalid = '<template><div /></template><liva>motion {</liva>'

  await writeFile(file, invalid)
  block = 'motion {'

  expect(await call('transform', invalid, file)).toBeUndefined()
  await expect(call('transform', block, `${file}?vue&type=liva`)).rejects.toThrow(
    /expected|Expected/,
  )
})

it('registers Presence assets in the component emitted for a lifecycle block', async () => {
  const { call } = hooks()
  const loader = await call(
    'transform',
    'motion fade { layer base { opacity: 1 } @tween() enter { opacity: 0 } }',
    `${file}?vue&type=liva`,
  )

  expect(loader.code).toContain(
    '"LivaCompiledPresenceBoundary": LivaPresenceBoundary, ...component.components',
  )
  expect(loader.code).toContain('"livaCompiledEntry": livaEntry, ...component.directives')
})

it('carries a free Presence name from the template into its custom block loader', async () => {
  const { call } = hooks()
  const lifecycle = 'motion fade { layer base { opacity: 1 } @tween() leave { opacity: 0 } }'
  const authored = `<script setup>
    const LivaCompiledPresenceBoundary = {}
    const vLivaCompiledEntry1 = {}
  </script>
  <template><div v-if="true" v-liva:fade /></template>
  <liva lang="liva">${lifecycle}</liva>`

  const planned = await call('transform', authored, file)
  const loader = await call('transform', lifecycle, `${file}?vue&type=liva&liva-presence-index=2`)

  expect(planned.code).toContain('<LivaCompiledPresenceBoundary2 ')
  expect(planned.code).toContain('v-liva-compiled-entry2=')
  expect(planned.code).toContain('liva-presence-index="2"')
  expect(loader.code).toContain('"LivaCompiledPresenceBoundary2": LivaPresenceBoundary')
  expect(loader.code).toContain('"livaCompiledEntry2": livaEntry')
})

it('retains the accepted template and loader after structural Presence validation rejects HMR', async () => {
  const { call } = hooks()
  const events = development(call)
  const loader = `${file}?vue&type=liva`
  const ordinary = 'motion fade { layer base { opacity: 1 } }'
  const lifecycle = 'motion fade { layer base { opacity: 1 } @tween() leave { opacity: 0 } }'
  const before = `<template><div v-liva:fade /></template><liva>${ordinary}</liva>`
  const rejected = `<template><Transition><div v-if="true" v-liva:fade /></Transition></template><liva>${lifecycle}</liva>`
  const accepted = await call('transform', before, file)
  const acceptedLoader = await call('transform', ordinary, loader)

  expect(await call('handleHotUpdate', { file, read: async () => rejected })).toEqual([])
  expect(events.at(-1)).toMatchObject({ event: 'liva:diagnostics' })
  expect(await call('transform', rejected, file)).toEqual(accepted)
  expect(await call('transform', lifecycle, loader)).toEqual(acceptedLoader)

  const corrected = `<template><div v-if="true" v-liva:fade /></template><liva>${lifecycle}</liva>`

  expect(await call('handleHotUpdate', { file, read: async () => corrected })).toBeUndefined()
  expect((await call('transform', corrected, file)).code).toContain('LivaCompiledPresenceBoundary')
  expect((await call('transform', lifecycle, loader)).code).toContain('PresenceExecution')
})
