import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { marker } from './model.mjs'
import { example } from './test-fixture.mjs'
import {
  githubApi,
  isCurrent,
  readArtifact,
  report,
  verifyContext,
  workflowPath,
} from './report.mjs'

function zip(result, filename = 'result.json') {
  return execFileSync(
    'python3',
    [
      '-c',
      `import io,sys,zipfile
buffer=io.BytesIO()
with zipfile.ZipFile(buffer,'w') as archive:
    archive.writestr(sys.argv[1], sys.stdin.buffer.read())
sys.stdout.buffer.write(buffer.getvalue())`,
      filename,
    ],
    { input: JSON.stringify(result) },
  )
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
} = {}) {
  const pr = {
    number: 92,
    state: 'open',
    head: { sha: '1'.repeat(40), ref: 'feature', repo: { id: 2, full_name: 'fork/liva' } },
    base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'ktsn/liva' } },
  }
  const run = {
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
  const calls = []
  let prReads = 0
  const api = async (path, options = {}) => {
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

const writes = (calls) => calls.filter((call) => call.method)
const botComment = {
  id: 40,
  user: { login: 'github-actions[bot]', type: 'Bot' },
  body: `${marker}\nold`,
}

test('creates one bot comment, ignores a user marker, and updates the bot comment', async () => {
  for (const comments of [
    [],
    [{ ...botComment, user: { login: 'someone', type: 'User' } }],
    [botComment],
  ]) {
    const { api, event, calls } = github({ comments })

    assert.equal(await report(api, event, 'ktsn/liva'), 'success')
    assert.equal(writes(calls).length, 1)
    assert.equal(writes(calls)[0].method, comments[0] === botComment ? 'PATCH' : 'POST')
    assert(writes(calls)[0].body.body.startsWith(marker))
  }
})

test('failure on either measured side updates the existing comment', async () => {
  for (const side of ['base', 'head']) {
    const artifact = example()

    artifact.status = 'failure'
    artifact[side] = { sha: artifact[side].sha, error: 'build failed' }

    const { api, event, calls } = github({
      comments: [botComment],
      conclusion: 'failure',
      artifact,
    })

    assert.equal(await report(api, event, 'ktsn/liva'), 'failure')
    assert.equal(writes(calls)[0].method, 'PATCH')
    assert.match(writes(calls)[0].body.body, new RegExp(`failed:.*${side}`))
  }
})

test('failure before artifact creation supersedes the previous successful result', async () => {
  const { api, event, calls } = github({
    comments: [botComment],
    conclusion: 'failure',
    artifact: null,
    fork: true,
  })

  assert.equal(await report(api, event, 'ktsn/liva'), 'failure')
  assert.match(writes(calls)[0].body.body, /setup or artifact publication/)
  assert.equal(writes(calls)[0].method, 'PATCH')
})

test('invalid artifact and wrong PR are rejected and reporting fails after trusted failure update', async () => {
  for (const change of [
    (r) => {
      r.context.pr = 12
    },
    (r) => {
      r.context.run++
    },
    (r) => {
      r.context.attempt++
    },
    (r) => {
      r.context.baseBranch = 'other'
    },
    (r) => {
      r.head.sha = '2'.repeat(40)
    },
    (r) => {
      r.head.bytes.gzip = -1
    },
  ]) {
    const artifact = example()

    change(artifact)

    const { api, event, calls } = github({ artifact })

    await assert.rejects(report(api, event, 'ktsn/liva'), /artifact rejected/)
    assert.match(writes(calls)[0].body.body, /Measurement failed/)
    assert.doesNotMatch(writes(calls)[0].body.body, /Minified JS/)
  }
})

test('older runs, old attempts, changed heads and retargets cannot overwrite current comments', async () => {
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

test('fork association and a newer same-head run for a different PR still report the intended PR', async () => {
  const { api, event, calls } = github({ fork: true, otherPr: true })

  assert.equal(await report(api, event, 'ktsn/liva'), 'success')
  assert.equal(writes(calls)[0].path, '/issues/92/comments')
})

test('unexpected workflow identity cannot reach artifact download or comment APIs', async () => {
  const { api, event, calls } = github()
  const wrong = async (path, options) =>
    path === `/actions/runs/${event.workflow_run.id}`
      ? { ...event.workflow_run, workflow_id: 99 }
      : api(path, options)

  await assert.rejects(report(wrong, event, 'ktsn/liva'), /originating workflow/)
  assert.deepEqual(writes(calls), [])
})

test('API comment write errors remain observable', async () => {
  const { api, event } = github()
  const failing = (path, options) =>
    options?.method ? Promise.reject(new Error('API unavailable')) : api(path, options)

  await assert.rejects(report(failing, event, 'ktsn/liva'), /API unavailable/)
})

test('ZIP reader rejects extra paths, traversal names and oversized content', () => {
  assert.throws(() => readArtifact(zip(example(), '../result.json')))
  assert.throws(() => readArtifact(zip('x'.repeat(100_001))))
  assert.throws(() => readArtifact(Buffer.alloc(1_000_001)))
  assert.deepEqual(readArtifact(zip(example())), example())
})

test('final freshness guard requires matching live run attempt, latest event and open PR', () => {
  const { run, pr } = github()

  assert(isCurrent(run, run, run, pr))
  assert(!isCurrent(run, run, { ...run, id: run.id + 1 }, pr))
  assert(!isCurrent(run, run, run, { ...pr, state: 'closed' }))
  assert.throws(() =>
    verifyContext(example(), { ...run, head_sha: '2'.repeat(40) }, pr, 'ktsn/liva'),
  )
})
test('REST client paginates comment and workflow collections without following untrusted URLs', async () => {
  for (const collection of [true, 'workflow_runs']) {
    const requests = []
    const api = githubApi({
      repository: 'ktsn/liva',
      token: 'test-token',
      apiUrl: 'https://api.github.com',
      fetcher: async (url) => {
        requests.push(url)

        const second = new URL(url).searchParams.get('page') === '2'
        const rows = [{ id: second ? 2 : 1 }]
        const body = collection === true ? rows : { workflow_runs: rows }

        return new Response(JSON.stringify(body), {
          headers: second ? {} : { link: '<https://untrusted.example/>; rel="next"' },
        })
      },
    })
    const result = await api('/actions/runs?per_page=100', { paginate: collection })

    assert.deepEqual(collection === true ? result : result.workflow_runs, [{ id: 1 }, { id: 2 }])
    assert.equal(requests.length, 2)
    assert(requests.every((url) => url.startsWith('https://api.github.com/repos/ktsn/liva/')))
  }
})

test('REST client rejects API errors and bounds downloads even without content-length', async () => {
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
