import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { readFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definitionJson, digest, measure, sizes, specification } from './measure.ts'
import { text } from './data.ts'
import { configure, output, setApi } from './__test__/tools/dist/index.ts'
import { setPlugin as setVue } from './__test__/tools/vue.ts'
import { setPlugin as setLiva } from './__test__/tools/target/packages/vite/src/index.ts'

vi.mock('node:fs/promises', { spy: true })
vi.mock('node:child_process', { spy: true })
vi.mock('node:module', { spy: true })

const actualModule = await vi.importActual<typeof import('node:module')>('node:module')
const target = fileURLToPath(new URL('./__test__/tools/target', import.meta.url))
const tools = fileURLToPath(new URL('./__test__/tools', import.meta.url))
const sha = 'a'.repeat(40)
let files: Map<string, string | Buffer<ArrayBuffer>>
const argv = process.argv

beforeEach(() => {
  vi.resetAllMocks()
  configure((config) => output(config))
  setVue(() => ({ name: 'vue' }))
  setLiva(() => ({ name: 'liva' }))
  files = new Map<string, string | Buffer<ArrayBuffer>>([
    [
      join(target, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '7.1.0' }, packageManager: 'pnpm@12.21.0' }),
    ],
    [join(target, 'node_modules/typescript/package.json'), '{"version":"7.1.0"}'],
    [join(target, 'vue/package.json'), '{"version":"3.5.45"}'],
    [join(target, 'crates/liva_wasm/Cargo.toml'), 'wasm-bindgen = "=0.2.130"'],
    [join(target, 'pnpm-lock.yaml'), Buffer.from('dependencies')],
    [join(target, 'Cargo.lock'), Buffer.from('compiler dependencies')],
    [join(target, 'packages/vite/wasm/liva_wasm_bg.wasm'), Buffer.from('wasm')],
    [join(tools, 'oxc/package.json'), '{"version":"0.157.0"}'],
  ])

  vi.mocked(createRequire).mockImplementation(() => {
    const require = actualModule.createRequire(import.meta.url)
    const resolve = Object.assign(
      vi.fn((id: string) => {
        if (id === 'vite-plus/package.json') return join(tools, 'package.json')
        if (id === '@vizejs/vite-plugin') return join(tools, 'vue.ts')
        if (id === 'vue/package.json') return join(target, 'vue/package.json')
        if (id === 'vite/package.json') return join(tools, 'vite/package.json')
        if (id === 'oxc-transform/package.json') return join(tools, 'oxc/package.json')

        throw new Error(`Unexpected dependency ${id}`)
      }),
      { paths: (request: string) => require.resolve.paths(request) },
    )

    return Object.assign(require, { resolve })
  })
  vi.mocked(mkdtemp).mockResolvedValue('/fixture')
  vi.mocked(cp).mockResolvedValue(undefined)
  vi.mocked(rm).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(readFile).mockImplementation(async (path) => {
    const name = path instanceof URL ? fileURLToPath(path) : text(path)
    return files.get(name) ?? Buffer.from(`source:${name}`)
  })
  vi.mocked(execFileSync).mockReturnValue('rustc 1.100.0 (test 2026-11-01)\n')
})

afterEach(() => {
  process.argv = argv
  vi.unstubAllEnvs()
})

describe('production measurement', () => {
  it('rejects an unsupported Node runtime before loading build tools or allocating resources', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
    assert(descriptor)

    try {
      Object.defineProperty(process.versions, 'node', { ...descriptor, value: '0.0.0' })
      await expect(measure(target, sha)).rejects.toThrow('Use Node 26.13.1')
      expect(mkdtemp).not.toHaveBeenCalled()
      expect(createRequire).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.versions, 'node', descriptor)
    }
  })

  it('derives metrics, hashes and revision-specific metadata from the actual build output', async () => {
    const result = await measure(target, sha, '/output')
    const bytes = Buffer.from('export const message="hello é";')

    expect(result.bytes).toStrictEqual(sizes(bytes, '{"definitions":[{"label":"é"}]}'))
    expect(result.bundle).toBe(digest(bytes))
    expect(result.metadata.dependencies).toStrictEqual({ typescript: '7.1.0', vue: '3.5.45' })
    expect(result.metadata.lockfile).toBe(digest(Buffer.from('dependencies')))
    expect(result.metadata.wasm).toBe(digest(Buffer.from('wasm')))
    const modules = vi
      .mocked(writeFile)
      .mock.calls.find(([path]) => path === '/output/modules.json')
    expect(text(modules?.[1])).toContain('<fixture>/Button.vue')
    expect(text(modules?.[1])).toContain('<target>/packages/runtime/src/index.ts')
    expect(text(modules?.[1])).not.toContain(target)
    expect(text(modules?.[1])).not.toContain('/unused.ts')
    expect(rm).toHaveBeenCalledWith('/fixture', { recursive: true, force: true })
  })

  it('detects output growth/removal and dependency changes without relying on cached results', async () => {
    const first = await measure(target, sha)
    configure((config) =>
      output(config, { code: 'export const message="' + 'abcdef'.repeat(1000) + '";' }),
    )
    const larger = await measure(target, sha)

    for (const key of ['minified', 'gzip', 'brotli'] as const)
      expect(larger.bytes[key]).toBeGreaterThan(first.bytes[key])
    expect(larger.bytes.definitions).toBe(first.bytes.definitions)

    configure((config) => output(config))
    expect(await measure(target, sha)).toStrictEqual(first)

    files.set(join(target, 'node_modules/typescript/package.json'), '{"version":"7.2.0"}')
    files.set(join(target, 'pnpm-lock.yaml'), Buffer.from('updated dependency'))
    const changed = await measure(target, sha)

    expect(changed.metadata.dependencies.typescript).toBe('7.2.0')
    expect(changed.metadata.lockfile).not.toBe(first.metadata.lockfile)
  })

  it.each([{ build: null }, { version: 1 }, { rolldownVersion: null }])(
    'rejects incompatible build APIs before allocating a fixture: %j',
    async (api) => {
      setApi(api)
      await expect(measure(target, sha)).rejects.toThrow('Unsupported production build API')
      expect(mkdtemp).not.toHaveBeenCalled()
    },
  )

  it.each(['vue', 'liva'])('rejects an incompatible %s plugin factory', async (name) => {
    if (name === 'vue') setVue(null)
    else setLiva(null)

    await expect(measure(target, sha)).rejects.toThrow('Unsupported production plugin API')
  })

  it.each([
    [{ definition: false }, 'Production definition extraction failed'],
    [{ duplicate: true }, 'Expected exactly one production loader'],
    [{ generate: false }, 'Production modules were not observed'],
    [{ extraChunk: true }, 'Expected exactly one shipped file'],
    [{ type: 'asset' }, 'falsy value'],
    [{ imports: ['vue', 'unexpected'] }, 'Unexpected shipped dependency'],
    [{ dynamicImports: ['dynamic'] }, 'strictly deep'],
    [{ result: [] }, 'Expected a single production chunk'],
    [{ result: {} }, 'Expected a single production chunk'],
    [{ result: { output: [{ type: 'asset' }] } }, 'Expected a single production chunk'],
    [{ modules: {} }, 'Missing production module'],
    [{ code: 'const editor="__LIVA_EDITOR__";' }, 'Unexpected production content'],
  ] as const)(
    'rejects invalid production artifacts and releases the fixture (%j)',
    async (options, message) => {
      configure((config) => output(config, options))
      await expect(measure(target, sha)).rejects.toThrow(new RegExp(message, 'i'))
      expect(rm).toHaveBeenCalledWith('/fixture', { recursive: true, force: true })
    },
  )

  it('rejects forbidden rendered modules even when required production modules are present', async () => {
    configure((config) =>
      output(config, { extraModules: { '/compiler.ts': { renderedLength: 1 } } }),
    )
    await expect(measure(target, sha)).rejects.toThrow('Unexpected bundled compiler')
  })

  it.each([
    {
      stage: 'copy',
      setup: () => vi.mocked(cp).mockRejectedValueOnce(new Error('copy failed')),
      message: 'copy failed',
    },
    {
      stage: 'build',
      setup: () =>
        configure(async () => {
          throw new Error('build failed')
        }),
      message: 'build failed',
    },
    {
      stage: 'metadata',
      setup: () => files.set(join(target, 'crates/liva_wasm/Cargo.toml'), 'unsupported manifest'),
      message: 'Expected string',
    },
    {
      stage: 'output copy',
      setup: () =>
        vi
          .mocked(cp)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('output copy failed')),
      message: 'output copy failed',
    },
    {
      stage: 'output write',
      setup: () => vi.mocked(writeFile).mockRejectedValueOnce(new Error('output write failed')),
      message: 'output write failed',
    },
  ])('cleans up when $stage fails', async ({ setup, message }) => {
    setup()
    await expect(measure(target, sha, '/output')).rejects.toThrow(message)
    expect(rm).toHaveBeenCalledWith('/fixture', { recursive: true, force: true })
  })

  it('fingerprints fixture and producer contents, so changes cannot masquerade as matching conditions', async () => {
    const first = await specification()
    files.set(
      fileURLToPath(new URL('../fixture/main.ts', import.meta.url)),
      Buffer.from('changed fixture'),
    )
    const changed = await specification()

    expect(changed.fixture).not.toBe(first.fixture)
    expect(changed.harness).toBe(first.harness)

    files.set(
      fileURLToPath(new URL('./measure.ts', import.meta.url)),
      Buffer.from('changed producer'),
    )
    const producerChanged = await specification()
    expect(producerChanged.fixture).toBe(changed.fixture)
    expect(producerChanged.harness).not.toBe(changed.harness)
  })

  it('dispatches the native TypeScript measurement worker and writes its validated result', async () => {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('./measure.ts', import.meta.url)),
      target,
      sha,
      '/result.json',
    ]
    const entry = new URL('./measure.ts?entrypoint-unit', import.meta.url)
    await import(entry.href)
    const written = vi.mocked(writeFile).mock.calls.find(([path]) => path === '/result.json')
    expect(JSON.parse(text(written?.[1]))).toMatchObject({
      sha,
      bytes: { definitions: Buffer.byteLength('{"definitions":[{"label":"é"}]}') },
    })
  })
})

describe('definition extraction', () => {
  it.each([
    {
      body: [{ type: 'VariableDeclaration', declarations: [{ id: { name: 'other' }, init: {} }] }],
    },
    { body: [{ type: 'VariableDeclaration', declarations: [{ id: { name: 'bundle' } }] }] },
  ])('rejects declarations without an initialized bundle: %j', (ast) => {
    expect(() => definitionJson(ast)).toThrow('Unsupported production definition loader')
  })
})
