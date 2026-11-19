import assert from 'node:assert/strict'
import { ZipEntry, createZipArchiveSync } from 'node:zlib'
import { test } from 'node:test'
import { marker } from './model.ts'
import { array, object } from './data.ts'
import type { Comment, PullRequest, Run } from './github-data.ts'
import type { Api, ApiOptions } from './report.ts'
import { example, readField, replaceField } from './test-fixture.ts'
import {
  githubApi,
  isCurrent,
  readArtifact,
  report,
  verifyContext,
  workflowPath,
} from './report.ts'

function zip(result: unknown, filename = 'result.json'): Buffer {
  const entry = ZipEntry.createSync(filename, Buffer.from(JSON.stringify(result)), {
    method: 'store',
  })

  return Buffer.concat([...createZipArchiveSync([entry])])
}

interface Scenario {
  comments?: Comment[]
  conclusion?: string
  artifact?: unknown
  attempt?: number
  newer?: boolean
  changedHead?: boolean
  changedBase?: boolean
  fork?: boolean
  otherPr?: boolean
}
interface Call extends ApiOptions {
  path: string
}

function github({
  comments = [],
  conclusion = 'success',
  artifact = example(),
  attempt = 1,
  newer = false,
  changedHead = false,
  changedBase = false,
  fork = false,
  otherPr = false,
}: Scenario = {}) {
  const pr: PullRequest = {
    number: 92,
    state: 'open',
    head: { sha: '1'.repeat(40), ref: 'feature', repo: { id: 2, full_name: 'fork/liva' } },
    base: { ref: 'main', sha: 'a'.repeat(40), repo: { id: 1, full_name: 'ktsn/liva' } },
  }
  const run: Run = {
    id: 10000000001,
    run_attempt: 1,
    event: 'pull_request',
    workflow_id: 10,
    path: workflowPath,
    status: 'completed',
    conclusion,
    display_title: 'Bundle size PR #92 to main',
    head_sha: pr.head.sha,
    head_branch: pr.head.ref,
    head_repository: pr.head.repo,
    repository: { full_name: 'ktsn/liva' },
    pull_requests: fork ? [] : [{ number: pr.number }],
  }
  const calls: Call[] = []
  let prReads = 0
  const api: Api = async (path, options = {}) => {
    calls.push({ path, ...options })

    if (options.method) return {}
    if (path === `/actions/runs/${run.id}`) return { ...run, run_attempt: attempt }
    if (path === '/actions/workflows/bundle-size.yml') return { id: 10 }
    if (path.startsWith('/commits/')) return [{ number: 92 }, ...(otherPr ? [{ number: 93 }] : [])]
    if (path === '/pulls/92') {
      prReads++

      const current = structuredClone(pr)

      if (prReads > 1 && changedHead) current.head.sha = '9'.repeat(40)
      if (prReads > 1 && changedBase) current.base.ref = 'release'

      return current
    }
    if (path.endsWith('/artifacts'))
      return {
        artifacts:
          artifact === null
            ? []
            : [
                {
                  id: 5,
                  name: `bundle-size-${run.id}-${attempt}`,
                  size_in_bytes: 1000,
                  expired: false,
                },
              ],
      }
    if (path === '/actions/artifacts/5/zip') return zip(artifact)
    if (path.startsWith('/actions/workflows/10/runs?'))
      return {
        workflow_runs: [
          ...(newer ? [{ ...run, id: run.id + 1 }] : []),
          ...(otherPr
            ? [{ ...run, id: run.id + 2, display_title: 'Bundle size PR #93 to release' }]
            : []),
          run,
        ],
      }
    if (path.startsWith('/issues/92/comments?')) return comments

    throw new Error(`Unexpected API request: ${path}`)
  }

  return { api, event: { workflow_run: run }, calls, run, pr }
}

const writes = (calls: Call[]) => calls.filter((call) => call.method)
function posted(calls: Call[]): Call & { body: { body: string } } {
  const call = writes(calls)[0]

  assert(call && call.body, 'Expected a comment publication')

  return { ...call, body: call.body }
}

const botComment = {
  id: 40,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  body: `${marker}\nold`,
}

await test('creates one bot comment, ignores a user marker, and updates the bot comment', async () => {
  for (const comments of [
    [],
    [{ ...botComment, user: { login: 'someone', type: 'User' } }],
    [botComment],
  ]) {
    const { api, event, calls } = github({ comments })

    assert.equal(await report(api, event, 'ktsn/liva'), 'success')
    assert.equal(writes(calls).length, 1)
    assert.equal(writes(calls)[0].method, comments[0] === botComment ? 'PATCH' : 'POST')
    assert(posted(calls).body.body.startsWith(marker))
  }
})

await test('failure on either measured side updates the existing comment', async () => {
  for (const side of ['base', 'head'] as const) {
    const artifact = example()

    replaceField(artifact, ['status'], 'failure')
    replaceField(artifact, [side], { sha: artifact[side].sha, error: 'build failed' })

    const { api, event, calls } = github({
      comments: [botComment],
      conclusion: 'failure',
      artifact,
    })

    assert.equal(await report(api, event, 'ktsn/liva'), 'failure')
    assert.equal(writes(calls)[0].method, 'PATCH')
    assert.match(posted(calls).body.body, new RegExp(`failed:.*${side}`))
  }
})

await test('failure before artifact creation supersedes the previous successful result', async () => {
  const { api, event, calls } = github({
    comments: [botComment],
    conclusion: 'failure',
    artifact: null,
    fork: true,
  })

  assert.equal(await report(api, event, 'ktsn/liva'), 'failure')
  assert.match(posted(calls).body.body, /setup or artifact publication/)
  assert.equal(writes(calls)[0].method, 'PATCH')
})

await test('invalid artifact and wrong PR are rejected and reporting fails after trusted failure update', async () => {
  const cases: [string[], unknown][] = [
    [['context', 'pr'], 12],
    [['context', 'run'], 10000000002],
    [['context', 'attempt'], 2],
    [['context', 'baseBranch'], 'other'],
    [['head', 'sha'], '2'.repeat(40)],
    [['head', 'bytes', 'gzip'], -1],
  ]

  for (const [path, invalid] of cases) {
    const artifact: unknown = example()

    replaceField(artifact, path, invalid)

    const { api, event, calls } = github({ artifact })

    await assert.rejects(report(api, event, 'ktsn/liva'), /artifact rejected/)
    assert.match(posted(calls).body.body, /Measurement failed/)
    assert.doesNotMatch(posted(calls).body.body, /Minified JS/)
  }
})

await test('coercible string arrays are rejected at the comment publication boundary', async () => {
  for (const path of [
    ['specification', 'fixture'],
    ['specification', 'harness'],
    ['base', 'sha'],
    ['head', 'bundle'],
    ['head', 'metadata', 'rustc'],
    ['head', 'metadata', 'lockfile'],
    ['head', 'metadata', 'cargoLockfile'],
    ['head', 'metadata', 'wasm'],
  ]) {
    const artifact = example()
    replaceField(artifact, path, [readField(artifact, path)])

    const { api, event, calls } = github({ artifact })

    await assert.rejects(report(api, event, 'ktsn/liva'), /artifact rejected/)
    assert.equal(writes(calls).length, 1)
    assert.match(posted(calls).body.body, /Measurement failed/)
    assert.doesNotMatch(posted(calls).body.body, /Minified JS/)
  }
})

await test('older runs, old attempts, changed heads and retargets cannot overwrite current comments', async () => {
  for (const options of [
    { newer: true },
    { attempt: 2 },
    { changedHead: true },
    { changedBase: true },
  ]) {
    const { api, event, calls } = github(options)

    assert.match(await report(api, event, 'ktsn/liva'), /stale/)
    assert.deepEqual(writes(calls), [])
  }
})

await test('fork association and a newer same-head run for a different PR still report the intended PR', async () => {
  const { api, event, calls } = github({ fork: true, otherPr: true })

  assert.equal(await report(api, event, 'ktsn/liva'), 'success')
  assert.equal(writes(calls)[0].path, '/issues/92/comments')
})

await test('unexpected workflow identity cannot reach artifact download or comment APIs', async () => {
  const { api, event, calls } = github()
  const wrong: Api = async (path, options) =>
    path === `/actions/runs/${event.workflow_run.id}`
      ? { ...event.workflow_run, workflow_id: 99 }
      : api(path, options)

  await assert.rejects(report(wrong, event, 'ktsn/liva'), /originating workflow/)
  assert.deepEqual(writes(calls), [])
})

await test('unknown workflow event and REST response fields are narrowed before publication', async () => {
  const { api, event, calls } = github()
  const invalidRun: Api = async (path, options) =>
    path === `/actions/runs/${event.workflow_run.id}`
      ? { ...event.workflow_run, head_sha: [event.workflow_run.head_sha] }
      : api(path, options)

  await assert.rejects(report(invalidRun, event, 'ktsn/liva'), /Expected string/)
  await assert.rejects(
    report(api, { workflow_run: { id: 'not-an-id' } }, 'ktsn/liva'),
    /Expected positive integer/,
  )
  assert.deepEqual(writes(calls), [])
})

await test('API comment write errors remain observable', async () => {
  const { api, event } = github()
  const failing: Api = (path, options) =>
    options?.method ? Promise.reject(new Error('API unavailable')) : api(path, options)

  await assert.rejects(report(failing, event, 'ktsn/liva'), /API unavailable/)
})

await test('ZIP reader rejects extra paths, traversal names and oversized content', () => {
  assert.throws(() => readArtifact(zip(example(), '../result.json')))
  assert.throws(() => readArtifact(zip('x'.repeat(100_001))))
  assert.throws(() => readArtifact(Buffer.alloc(1_000_001)))
  assert.deepEqual(readArtifact(zip(example())), example())
})

await test('final freshness guard requires matching live run attempt, latest event and open PR', () => {
  const { run, pr } = github()

  assert(isCurrent(run, run, run, pr))
  assert(!isCurrent(run, run, { ...run, id: run.id + 1 }, pr))
  assert(!isCurrent(run, run, run, { ...pr, state: 'closed' }))
  assert.throws(() =>
    verifyContext(example(), { ...run, head_sha: '2'.repeat(40) }, pr, 'ktsn/liva'),
  )
})
await test('REST client paginates comment and workflow collections without following untrusted URLs', async () => {
  for (const collection of [true, 'workflow_runs'] as const) {
    const requests: string[] = []
    const api = githubApi({
      repository: 'ktsn/liva',
      token: 'test-token',
      apiUrl: 'https://api.github.com',
      fetcher: async (url) => {
        const address = url instanceof Request ? url.url : url.toString()

        requests.push(address)

        const second = new URL(address).searchParams.get('page') === '2'
        const rows = [{ id: second ? 2 : 1 }]
        const body = collection === true ? rows : { workflow_runs: rows }

        return new Response(JSON.stringify(body), {
          headers: second ? {} : { link: '<https://untrusted.example/>; rel="next"' },
        })
      },
    })
    const result = await api('/actions/runs?per_page=100', { paginate: collection })

    assert.deepEqual(collection === true ? array(result) : array(object(result).workflow_runs), [
      { id: 1 },
      { id: 2 },
    ])
    assert.equal(requests.length, 2)
    assert(requests.every((url) => url.startsWith('https://api.github.com/repos/ktsn/liva/')))
  }
})

await test('REST client rejects API errors and bounds downloads even without content-length', async () => {
  const failed = githubApi({
    repository: 'ktsn/liva',
    token: 'test',
    apiUrl: 'https://api.github.com',
    fetcher: async () => new Response('', { status: 403 }),
  })

  await assert.rejects(failed('/actions/runs'), /403/)

  const oversized = githubApi({
    repository: 'ktsn/liva',
    token: 'test',
    apiUrl: 'https://api.github.com',
    fetcher: async () => new Response(Buffer.alloc(1_000_001)),
  })

  await assert.rejects(oversized('/actions/artifacts/5/zip', { binary: true }), /too large/)
})
