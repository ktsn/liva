import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { array, environment, number, object } from './data.ts'
import {
  artifacts,
  candidates,
  comments as decodeComments,
  pullRequest,
  workflowRun,
  type PullRequest,
  type Run,
} from './github-data.ts'
import type { Comparison } from './types.ts'
import { formatComment, marker, validateResult } from './model.ts'

export const workflowPath = '.github/workflows/bundle-size.yml'

/** Artifact identity is checked against live GitHub data, never used to select the PR. */
export function verifyContext(result: Comparison, run: Run, pr: PullRequest, repository: string) {
  const context = result.context

  assert(context, 'CI context missing')
  assert.equal(context.repository, repository)
  assert.equal(context.run, run.id)
  assert.equal(context.attempt, run.run_attempt)
  assert.equal(context.pr, pr.number)
  assert.equal(context.baseBranch, pr.base.ref)
  assert.equal(context.headRepository, pr.head.repo.full_name)
  assert.equal(context.headBranch, pr.head.ref)
  assert.equal(result.head.sha, run.head_sha)
  assert.equal(result.head.sha, pr.head.sha)
}

export function runIdentity(run: Pick<Run, 'display_title'>) {
  const match = /^Bundle size PR #([1-9][0-9]*) to (.+)$/.exec(run.display_title || '')

  return match && { pr: Number(match[1]), baseBranch: match[2] }
}

export function matchesRun(run: Run, pr: PullRequest) {
  return (
    run.event === 'pull_request' &&
    run.head_sha === pr.head.sha &&
    run.head_branch === pr.head.ref &&
    run.head_repository?.id === pr.head.repo.id
  )
}

export function isCurrent(run: Run, currentRun: Run, latestRun: Run | undefined, pr: PullRequest) {
  return (
    pr.state === 'open' &&
    matchesRun(run, pr) &&
    currentRun.run_attempt === run.run_attempt &&
    latestRun?.id === run.id
  )
}

/** Read exactly one bounded JSON file; no archive paths are extracted or executed. */
export function readArtifact(zip: Buffer): unknown {
  assert(zip.length <= 1_000_000, 'Artifact ZIP too large')

  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    files = archive.infolist()
    assert len(files) == 1 and files[0].filename == 'result.json', 'Unexpected artifact files'
    assert files[0].file_size <= 100000, 'Result JSON too large'
    sys.stdout.buffer.write(archive.read(files[0]))
`,
      ],
      { input: zip, maxBuffer: 100_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString('utf8'),
  )
}

export async function report(api: Api, event: unknown, repository: string) {
  const notification = object(object(event).workflow_run)
  const run = workflowRun(await api(`/actions/runs/${number(notification.id)}`))
  const workflow = object(await api(`/actions/workflows/bundle-size.yml`))
  const workflowId = number(workflow.id)

  assert.equal(run.event, 'pull_request', 'Unexpected originating event')
  assert.equal(run.workflow_id, workflowId, 'Unexpected originating workflow')
  assert.equal(run.path, workflowPath)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.status, 'completed')

  if (run.run_attempt !== number(notification.run_attempt)) return 'stale attempt'

  if (run.conclusion === 'skipped') return 'irrelevant edit'

  const identity = runIdentity(run)

  assert(identity, 'Originating workflow has no target identity')

  // The API's run title remains available before checkout/install/artifact creation.
  // Commit association corroborates the title, including forks whose run PR list is empty.
  const associated = run.pull_requests.length
    ? run.pull_requests
    : candidates(await api(`/commits/${run.head_sha}/pulls`))

  assert(
    associated.some((candidate) => candidate.number === identity.pr),
    'Run target is not associated with its commit',
  )

  const pr = pullRequest(await api(`/pulls/${identity.pr}`))

  assert.equal(pr.base.repo.full_name, repository)

  if (!matchesRun(run, pr) || pr.base.ref !== identity.baseBranch || pr.state !== 'open')
    return 'superseded or closed PR'

  let result: Comparison | null = null
  let artifactError: unknown
  const artifactName = `bundle-size-${run.id}-${run.run_attempt}`

  try {
    const matches = artifacts(await api(`/actions/runs/${run.id}/artifacts`)).filter(
      (artifact) => artifact.name === artifactName && !artifact.expired,
    )

    if (matches.length === 0 && run.conclusion !== 'success') {
      result = null
    } else {
      assert.equal(matches.length, 1, 'Missing or duplicate result artifact')
      assert(matches[0].size_in_bytes <= 1_000_000, 'Artifact too large')
      result = validateResult(readArtifact(await artifactBytes(api, matches[0].id)))
      verifyContext(result, run, pr, repository)
      assert.equal(
        result.status === 'success',
        run.conclusion === 'success',
        'Run/result status mismatch',
      )
    }
  } catch (error) {
    artifactError = error
    result = null
  }

  const latest = async () => {
    const runs = await api(
      `/actions/workflows/${workflowId}/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&per_page=100`,
      { paginate: 'workflow_runs' },
    )

    // Run IDs increase on new events; rerunning an old run cannot reclaim freshness.
    return array(object(runs).workflow_runs)
      .map(workflowRun)
      .filter(
        (candidate) =>
          candidate.head_repository?.id === pr.head.repo.id &&
          candidate.head_branch === pr.head.ref &&
          runIdentity(candidate)?.pr === pr.number &&
          runIdentity(candidate)?.baseBranch === pr.base.ref &&
          candidate.conclusion !== 'skipped',
      )
      .toSorted((a, b) => b.id - a.id)[0]
  }
  const comments = decodeComments(
    await api(`/issues/${pr.number}/comments?per_page=100`, { paginate: true }),
  )
  const previous = comments.filter(
    (comment) =>
      comment.user.login === 'github-actions[bot]' &&
      comment.user.type === 'Bot' &&
      comment.body.startsWith(marker),
  )

  assert(previous.length <= 1, 'Multiple bundle-size bot comments')

  const [currentPr, currentRun, latestRun] = await Promise.all([
    api(`/pulls/${pr.number}`).then(pullRequest),
    api(`/actions/runs/${run.id}`).then(workflowRun),
    latest(),
  ])

  if (!isCurrent(run, currentRun, latestRun, currentPr) || currentPr.base.ref !== pr.base.ref)
    return 'stale result'

  const body = formatComment(result, {
    repository,
    run: run.id,
    attempt: run.run_attempt,
    headSha: currentPr.head.sha,
    baseSha: currentPr.base.sha,
  })

  if (previous[0]) {
    await api(`/issues/comments/${previous[0].id}`, { method: 'PATCH', body: { body } })
  } else {
    await api(`/issues/${pr.number}/comments`, { method: 'POST', body: { body } })
  }

  if (artifactError)
    throw new Error('Result artifact rejected; failure comment posted', { cause: artifactError })

  return result ? result.status : 'failure'
}

export interface ApiOptions {
  binary?: boolean
  paginate?: boolean | 'workflow_runs'
  method?: 'GET' | 'POST' | 'PATCH'
  body?: { body: string }
}
export type Api = (path: string, options?: ApiOptions) => Promise<unknown>

async function artifactBytes(api: Api, id: number): Promise<Buffer> {
  const bytes = await api(`/actions/artifacts/${id}/zip`, { binary: true })

  assert(Buffer.isBuffer(bytes))

  return bytes
}

export function githubApi({
  repository,
  token,
  apiUrl,
  fetcher = fetch,
}: {
  repository: string
  token: string
  apiUrl: string
  fetcher?: typeof fetch
}): Api {
  async function api(
    path: string,
    { binary = false, paginate = false, method = 'GET', body }: ApiOptions = {},
  ): Promise<unknown> {
    const response = await fetcher(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body && JSON.stringify(body),
    })

    assert(response.ok, `GitHub API ${method} ${path}: ${response.status}`)

    if (binary) {
      assert(Number(response.headers.get('content-length') || 0) <= 1_000_000)

      const chunks: Uint8Array[] = []
      let size = 0

      assert(response.body, 'Missing artifact response body')

      for await (const chunk of response.body) {
        size += chunk.length
        assert(size <= 1_000_000, 'Artifact download too large')
        chunks.push(chunk)
      }

      return Buffer.concat(chunks)
    }

    const value: unknown = await response.json()

    if (paginate && /rel="next"/.test(response.headers.get('link') || '')) {
      const next = new URL(path, 'https://api.github.com')
      const page = Number(next.searchParams.get('page') || 1)

      next.searchParams.set('page', String(page + 1))

      const rest = await api(`${next.pathname}${next.search}`, { paginate })

      return typeof paginate === 'string'
        ? {
            ...object(value),
            [paginate]: array(object(value)[paginate]).concat(array(object(rest)[paginate])),
          }
        : array(value).concat(array(rest))
    }

    return value
  }

  return api
}

async function main() {
  const repository = environment('GITHUB_REPOSITORY')
  const token = environment('GITHUB_TOKEN')

  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  assert(token, 'Missing GitHub token')

  const api = githubApi({ repository, token, apiUrl: environment('GITHUB_API_URL') })

  console.log(
    await report(
      api,
      JSON.parse(await readFile(environment('GITHUB_EVENT_PATH'), 'utf8')),
      repository,
    ),
  )
}

if (process.argv[1] === import.meta.filename) await main()
