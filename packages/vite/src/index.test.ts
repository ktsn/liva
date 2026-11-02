import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import liva from './index.ts'
import type { Plugin } from 'vite-plus'

let root: string
let file: string
let source: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'liva-plugin-'))
  file = join(root, 'Toggle.vue')
  source = `<template><div /></template><liva>${await readFile(new URL('../../../fixtures/toggle.liv', import.meta.url), 'utf8')}</liva>`
  await writeFile(file, source)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function hooks(plugin = liva()) {
  const warnings: unknown[] = []
  const context = {
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

  return { call, warnings }
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
  it('resolves the runtime plugin and ignores unrelated modules', () => {
    const { call } = hooks()

    expect(call('config')).toEqual({ optimizeDeps: { exclude: ['@liva/vue'] } })
    expect(call('resolveId', '@liva/vue')).toBe('\0liva:vue-plugin')
    expect(call('resolveId', './other')).toBeNull()
    expect(call('load', './other')).toBeNull()
    expect(call('load', '\0liva:vue-plugin')).toContain('createLivaPlugin()')
  })

  it('compiles custom blocks, reuses unchanged sources and skips other queries', async () => {
    const { call } = hooks()

    for (const id of ['file.ts', `${file}?vue&type=template`, `${file}?type=liva`]) {
      expect(await call('transform', '', id)).toBeUndefined()
    }

    expect(await call('transform', '<template><div /></template>', file)).toBeUndefined()
    expect(await call('transform', source, file)).toMatchObject({ code: source })

    const first = await call('transform', '', `${file}?vue&type=liva`)

    expect(first.code).toContain('decodeBundle')
    expect(first.code).toContain('toggle')
    expect(first.code).not.toContain('livaSource')
    expect(await call('transform', '', `${file}?vue&type=liva`)).toEqual(first)
  })

  it('rejects compilation errors in production', async () => {
    const { call } = hooks()
    const invalid = '<template><div /></template><liva>motion {</liva>'

    await writeFile(file, invalid)

    await expect(call('transform', invalid, file)).rejects.toThrow(/expected|Expected/)
    await expect(call('transform', '', `${file}?vue&type=liva`)).rejects.toThrow(
      /expected|Expected/,
    )
  })

  it('retains the last valid development compilation and reports hot-update diagnostics', async () => {
    const { call, warnings } = hooks()
    const events = development(call)

    expect(call('load', '\0liva:vue-plugin')).toContain('createDevPlugin')

    const first = await call('transform', '', `${file}?vue&type=liva`)

    expect(first.code).toContain('livaSource')

    const invalid = '<template><div /></template><liva>motion {</liva>'

    await writeFile(file, invalid)

    expect(await call('transform', invalid, file)).toMatchObject({ code: invalid })
    expect((await call('transform', '', `${file}?vue&type=liva`)).code).toBe(first.code)
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
    '<template><div v-liva:fade><Transition><div v-if="shown" v-liva-target:box /></Transition></div></template><liva>motion fade { state idle { box { opacity: 1 } } enter { @tween: 100ms; box { opacity { 0%: 0 } } } }</liva>'

  await writeFile(file, conflict)

  await expect(call('transform', conflict, file)).rejects.toThrow('Vue Transition conflicts')
})

it('does not invent a fallback compilation for an initially invalid development source', async () => {
  const { call } = hooks()

  development(call)

  const invalid = '<template><div /></template><liva>motion {</liva>'

  await writeFile(file, invalid)

  expect(await call('transform', invalid, file)).toBeUndefined()
  await expect(call('transform', '', `${file}?vue&type=liva`)).rejects.toThrow(/expected|Expected/)
})
