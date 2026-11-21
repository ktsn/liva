import { assert, describe, expect, it } from 'vite-plus/test'
import { pin, readOnlyGitEnvironment } from '../pin.ts'

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
