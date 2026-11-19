import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pin, readOnlyGitEnvironment } from './pin.ts'

const event = { pull_request: { number: 92, base: { ref: 'main' }, head: { sha: 'b'.repeat(40) } } }

await test('pins the base tip at start and actual head instead of merge-base or synthetic merge', () => {
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

  assert.deepEqual(fetched, ['refs/heads/main', 'refs/pull/92/head'])
  assert.deepEqual(result, {
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    pr: 92,
    baseBranch: 'main',
  })
})

await test('a head that changes while fetching is a failure rather than a silently different comparison', () => {
  assert.throws(
    () =>
      pin(
        event,
        () => {},
        () => 'c'.repeat(40),
      ),
    /PR changed/,
  )
})

await test('private-repository authentication is scoped to the pinning fetch process', () => {
  const parentEnvironment = { PATH: '/usr/bin' }
  const authenticated = readOnlyGitEnvironment(
    'read-token',
    'https://github.com',
    parentEnvironment,
  )

  assert.deepEqual(parentEnvironment, { PATH: '/usr/bin' })
  assert.equal(authenticated.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert(authenticated.GIT_CONFIG_VALUE_0)

  assert.equal(
    Buffer.from(authenticated.GIT_CONFIG_VALUE_0.split('basic ')[1], 'base64').toString(),
    'x-access-token:read-token',
  )
  assert.equal(authenticated.GIT_CONFIG_COUNT, '1')
})
