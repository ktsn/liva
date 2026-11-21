import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, main, prepareRevision } from './cli.ts'
import { specification } from './measure.ts'
import { text } from './data.ts'
import { validateResult } from './model.ts'
import { example } from './__test__/test-fixture.ts'

vi.mock('node:child_process', { spy: true })
vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })
vi.mock('./measure.ts', { spy: true })

const originalArgv = process.argv
const originalExitCode = process.exitCode
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
let manifest: string
let scripts: Record<string, string> | undefined
let installed: ReturnType<typeof spawnSync>
let workerFailure: unknown
let failDirectory: string
let pins: object
let writtenWorkers: Map<string, string>

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  manifest = 'wasm-bindgen = "=0.2.130"'
  scripts = undefined
  installed = {
    pid: 1,
    output: [],
    stdout: 'wasm-bindgen 0.2.130\n',
    stderr: '',
    status: 0,
    signal: null,
  }
  workerFailure = undefined
  failDirectory = ''
  writtenWorkers = new Map()
  pins = { pr: 92, baseBranch: 'main', base, head }
  vi.mocked(specification).mockResolvedValue(example().specification)
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(mkdtemp).mockResolvedValue('/temporary')
  vi.mocked(rm).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(existsSync).mockReturnValue(false)
  vi.mocked(spawnSync).mockImplementation((command) =>
    command === 'tar' ? { ...installed, status: 0 } : installed,
  )
  vi.mocked(readFile).mockImplementation(async (path) => {
    const name = text(path)
    if (name.endsWith('Cargo.toml')) return manifest
    if (name.endsWith('package.json')) return JSON.stringify({ scripts })
    if (name.endsWith('pins.json')) return JSON.stringify(pins)
    if (name === '/event.json')
      return JSON.stringify({
        pull_request: {
          number: 92,
          state: 'open',
          base: { ref: 'main', sha: base, repo: { id: 1, full_name: 'ktsn/liva' } },
          head: { ref: 'feature', sha: head, repo: { id: 2, full_name: 'fork/liva' } },
        },
      })
    const value = writtenWorkers.get(name)
    if (value === undefined) throw new Error(`No worker result at ${name}`)
    return value
  })
  vi.mocked(execFileSync).mockImplementation((command, args) => {
    const values = Array.isArray(args) ? args : []
    if (command === 'git') {
      if (values.includes('--show-toplevel')) return '/repository\n'
      if (values.includes('archive')) return Buffer.from('revision archive')
      return values.some((value) => value === `${head}^{commit}` || value === 'HEAD^{commit}')
        ? head
        : base
    }
    if (command === process.execPath) {
      if (failDirectory && String(values[1]).includes(failDirectory)) throw workerFailure
      const measurement = { ...example().head, sha: values[2] }
      writtenWorkers.set(String(values[3]), JSON.stringify(measurement))
    }
    return Buffer.alloc(0)
  })
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('revision preparation', () => {
  it('exports the whole revision and builds with its frozen dependencies and matching toolchain', async () => {
    await prepareRevision(head, '/revisions/head')
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repository', 'archive', head],
      expect.any(Object),
    )
    expect(spawnSync).toHaveBeenCalledWith(
      'tar',
      ['-x', '-C', '/revisions/head'],
      expect.objectContaining({ input: Buffer.from('revision archive') }),
    )
    expect(execFileSync).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: '/revisions/head' }),
    )
    expect(execFileSync).not.toHaveBeenCalledWith('cargo', expect.anything(), expect.anything())
    expect(execFileSync).not.toHaveBeenCalledWith('pnpm', ['build:packages'], expect.anything())
  })

  it('builds a revision’s JavaScript packages after generating its compiler WASM', async () => {
    scripts = { 'build:packages': 'node scripts/build-packages.ts' }

    await prepareRevision(head, '/revisions/head')

    expect(
      vi
        .mocked(execFileSync)
        .mock.calls.slice(-2)
        .map(([command, args]) => [command, args]),
    ).toEqual([
      ['sh', ['scripts/build-wasm.sh']],
      ['pnpm', ['build:packages']],
    ])
  })

  it.each([false, true])(
    'uses an isolated compiler CLI when the installed version differs (cached=%s)',
    async (cached) => {
      installed = { ...installed, status: null, error: new Error('spawn ENOENT') }
      // Failed executable lookup yields null streams at runtime, despite Node's generic stream type.
      Reflect.set(installed, 'stdout', null)
      vi.mocked(existsSync).mockReturnValue(cached)
      await prepareRevision(head, '/revisions/head')
      const cargo = vi.mocked(execFileSync).mock.calls.filter(([command]) => command === 'cargo')
      expect(cargo).toHaveLength(cached ? 0 : 1)
      const build = vi.mocked(execFileSync).mock.calls.find(([command]) => command === 'sh')
      expect(build?.[2]).toMatchObject({
        env: { PATH: expect.stringContaining('/revisions/wasm-bindgen-0.2.130/bin:') },
      })
    },
  )

  it('rejects failed extraction and unsupported toolchain manifests before building', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ ...installed, status: 1 })
    await expect(prepareRevision(head, '/head')).rejects.toThrow('Unable to export revision')
    expect(execFileSync).not.toHaveBeenCalledWith('pnpm', expect.anything(), expect.anything())

    manifest = 'wasm-bindgen = "latest"'
    await expect(prepareRevision(head, '/other')).rejects.toThrow(
      'Unsupported compiler toolchain manifest',
    )
    expect(execFileSync).not.toHaveBeenCalledWith('sh', expect.anything(), expect.anything())
  })
})

describe('comparison orchestration', () => {
  it('runs both revisions with separate native workers, records outputs and reproduces unchanged values', async () => {
    const result = await compare({
      base,
      head,
      baseDirectory: '/revision/base',
      headDirectory: '/revision/head',
      output: '/output',
    })
    expect(result.status).toBe('success')
    expect(result.base.sha).toBe(base)
    expect(result.head.sha).toBe(head)
    const workers = vi
      .mocked(execFileSync)
      .mock.calls.filter(([command]) => command === process.execPath)
    expect(workers).toHaveLength(2)
    expect(workers[0][1]).toContain('/output/base')
    expect(workers[1][1]).toContain('/output/head')
  })

  it.each(['base', 'head'])('retains the other side when the %s worker fails', async (side) => {
    failDirectory = side
    workerFailure = side === 'base' ? new Error('compiler failed') : 'native failure'
    const result = await compare({ base, head, baseDirectory: '/base', headDirectory: '/head' })
    expect(result.status).toBe('failure')
    expect(result[side === 'base' ? 'base' : 'head']).toHaveProperty(
      'error',
      side === 'base' ? 'compiler failed' : 'native failure',
    )
    expect(result[side === 'base' ? 'head' : 'base']).toHaveProperty('bytes')
  })

  it('bounds worker diagnostics and rejects malformed result payloads', async () => {
    failDirectory = 'base'
    workerFailure = 'x'.repeat(4000)
    const result = await compare({ base, head, baseDirectory: '/base', headDirectory: '/head' })
    expect(result.base).toHaveProperty('error', 'x'.repeat(2000))

    vi.mocked(readFile).mockResolvedValue('not json')
    const invalid = await compare({
      base,
      head,
      baseDirectory: '/base',
      headDirectory: '/head',
      single: true,
    })
    expect(invalid.status).toBe('failure')
  })
})

describe('command entry', () => {
  it.each(['measure', 'compare', 'ci'])(
    'writes validated JSON for %s and releases exported revisions',
    async (command) => {
      process.argv = ['node', 'cli.ts', command, base, 'HEAD', '/result-output']
      if (command === 'ci') {
        process.argv = ['node', 'cli.ts', command, '/result-output']
        vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
        vi.stubEnv('GITHUB_EVENT_PATH', '/event.json')
        vi.stubEnv('GITHUB_REPOSITORY', 'ktsn/liva')
        vi.stubEnv('GITHUB_RUN_ID', '10000000001')
        vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
        vi.stubEnv('RUNNER_TEMP', '/runner')
      }
      await main()
      const call = vi.mocked(writeFile).mock.calls.at(-1)
      assert(call)
      expect(text(call[0])).toContain('result.json')
      const result = validateResult(JSON.parse(text(call[1])))
      expect(result.status).toBe('success')
      expect(result.context?.pr ?? null).toBe(command === 'ci' ? 92 : null)
      expect(rm).toHaveBeenCalledWith('/temporary', { recursive: true, force: true })
    },
  )

  it('uses caller-relative default output, propagates setup failures, and fails CI on measurement failure', async () => {
    process.argv = ['node', 'cli.ts', 'compare', base, 'HEAD']
    failDirectory = 'head'
    workerFailure = new Error('worker failed')
    await main()
    expect(writeFile).toHaveBeenCalledWith(
      resolve('bundle-size-results/result.json'),
      expect.stringContaining('worker failed'),
    )
    expect(process.exitCode).toBe(1)

    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('bad revision')
    })
    await expect(main()).rejects.toThrow('bad revision')
    expect(rm).toHaveBeenCalledTimes(2)
  })

  it('releases allocated revisions when creating the output directory fails', async () => {
    process.argv = ['node', 'cli.ts', 'compare', base, 'HEAD']
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('output unavailable'))
    await expect(main()).rejects.toThrow('output unavailable')
    expect(rm).toHaveBeenCalledWith('/temporary', { recursive: true, force: true })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('rejects unsupported commands without creating temporary sources', async () => {
    process.argv = ['node', 'cli.ts', 'unknown']
    await expect(main()).rejects.toThrow('Usage:')
    expect(mkdtemp).not.toHaveBeenCalled()
  })

  it('refuses CI pins from another head and releases temporary sources', async () => {
    process.argv = ['node', 'cli.ts', 'ci']
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
    vi.stubEnv('GITHUB_EVENT_PATH', '/event.json')
    vi.stubEnv('RUNNER_TEMP', '/runner')
    pins = { pr: 92, baseBranch: 'main', base, head: base }
    await expect(main()).rejects.toThrow(Error)
    expect(rm).toHaveBeenCalled()
  })

  it('dispatches when invoked as the native TypeScript entry', async () => {
    process.argv = [
      'node',
      fileURLToPath(new URL('./cli.ts', import.meta.url)),
      'measure',
      base,
      '/native-output',
    ]
    const entry = new URL('./cli.ts?entrypoint-unit', import.meta.url)
    await import(entry.href)
    expect(writeFile).toHaveBeenCalledWith(
      '/native-output/result.json',
      expect.stringContaining(base),
    )
  })
})
