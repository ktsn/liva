import { text } from './data.ts'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, assert, describe, expect, it, vi } from 'vite-plus/test'
import { main, pin, readOnlyGitEnvironment } from './pin.ts'

vi.mock('node:child_process', { spy: true })
vi.mock('node:fs/promises', { spy: true })

const event = { pull_request: { number: 92, base: { ref: 'main' }, head: { sha: 'b'.repeat(40) } } }

describe('revision pinning', () => {
  it('pins the base tip at start and actual head instead of merge-base or synthetic merge', () => {
    const fetched: string[] = []
    const resolved = ['a'.repeat(40), 'b'.repeat(40)]
    const result = pin(
      event,
      (ref) => fetched.push(ref),
      () => {
        const sha = resolved.shift()
        assert(sha)
        return sha
      },
    )

    expect(fetched).toStrictEqual(['refs/heads/main', 'refs/pull/92/head'])
    expect(result).toStrictEqual({
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      pr: 92,
      baseBranch: 'main',
    })
  })

  it('a head that changes while fetching is a failure rather than a silently different comparison', () => {
    expect(() =>
      pin(
        event,
        () => {},
        () => 'c'.repeat(40),
      ),
    ).toThrow(/PR changed/)
  })

  it('private-repository authentication is scoped to the pinning fetch process', () => {
    const parentEnvironment = { PATH: '/usr/bin' }
    const authenticated = readOnlyGitEnvironment(
      'read-token',
      'https://github.com',
      parentEnvironment,
    )

    expect(parentEnvironment).toStrictEqual({ PATH: '/usr/bin' })
    expect(authenticated.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    assert(authenticated.GIT_CONFIG_VALUE_0)

    expect(
      Buffer.from(authenticated.GIT_CONFIG_VALUE_0.split('basic ')[1], 'base64').toString(),
    ).toBe('x-access-token:read-token')
    expect(authenticated.GIT_CONFIG_COUNT).toBe('1')
  })
})

describe('pin command entry', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
    vi.stubEnv('GITHUB_EVENT_PATH', '/event.json')
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com')
    vi.stubEnv('BUNDLE_SIZE_READ_TOKEN', 'read-only-token')
    process.argv = ['node', 'pin.ts', '/pins.json']
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(event))
    vi.mocked(writeFile).mockResolvedValue(undefined)
    const resolved = ['a'.repeat(40), 'b'.repeat(40)]
    vi.mocked(execFileSync).mockImplementation((_command, args) =>
      Array.isArray(args) && args[0] === 'rev-parse' ? (resolved.shift() ?? '') : '',
    )
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.unstubAllEnvs()
  })

  it('pins fetched refs in order using only process-scoped authentication', async () => {
    const parentConfig = process.env.GIT_CONFIG_COUNT
    await main()
    const fetches = vi
      .mocked(execFileSync)
      .mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'fetch')
    expect(fetches.map(([, args]) => args)).toStrictEqual([
      ['fetch', '--no-tags', 'origin', 'refs/heads/main'],
      ['fetch', '--no-tags', 'origin', 'refs/pull/92/head'],
    ])
    expect(fetches[0][2]).toMatchObject({ env: { GIT_CONFIG_COUNT: '1' } })
    expect(process.env.GIT_CONFIG_COUNT).toBe(parentConfig)
    const result: unknown = JSON.parse(text(vi.mocked(writeFile).mock.calls[0][1]))
    expect(result).toMatchObject({ base: 'a'.repeat(40), head: 'b'.repeat(40), pr: 92 })
  })

  it('refuses unrelated events and missing credentials before fetching', async () => {
    vi.stubEnv('GITHUB_EVENT_NAME', 'push')
    await expect(main()).rejects.toThrow(Error)
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request')
    vi.stubEnv('BUNDLE_SIZE_READ_TOKEN', '')
    await expect(main()).rejects.toThrow('Missing read-only fetch token')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('dispatches the native TypeScript pin entry without retaining credentials', async () => {
    process.argv[1] = fileURLToPath(new URL('./pin.ts', import.meta.url))
    const entry = new URL('./pin.ts?entrypoint-unit', import.meta.url)
    await import(entry.href)
    expect(writeFile).toHaveBeenCalledWith('/pins.json', expect.stringContaining('"pr":92'))
  })
})
