import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

/** Only this process receives the read token; dependency installs/builds run in later steps. */
export function pin(event, fetchRef, resolveFetch) {
  const pr = event.pull_request

  assert(pr && Number.isSafeInteger(pr.number))

  fetchRef(`refs/heads/${pr.base.ref}`)

  const base = resolveFetch()

  fetchRef(`refs/pull/${pr.number}/head`)

  const head = resolveFetch()

  assert.equal(head, pr.head.sha, 'PR changed before measurement started')

  return { base, head, pr: pr.number, baseBranch: pr.base.ref }
}

/** Pass authentication as process-scoped Git config; never write it to repository config. */
export function readOnlyGitEnvironment(token, server, environment = process.env) {
  return {
    ...environment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

async function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request')

  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const token = process.env.BUNDLE_SIZE_READ_TOKEN

  assert(token, 'Missing read-only fetch token')

  const gitEnvironment = readOnlyGitEnvironment(token, process.env.GITHUB_SERVER_URL)
  const result = pin(
    event,
    (ref) =>
      execFileSync('git', ['fetch', '--no-tags', 'origin', ref], {
        env: gitEnvironment,
        stdio: ['ignore', 'inherit', 'inherit'],
      }),
    () => execFileSync('git', ['rev-parse', 'FETCH_HEAD^{commit}'], { encoding: 'utf8' }).trim(),
  )

  await writeFile(process.argv[2], `${JSON.stringify(result)}\n`)
}

if (process.argv[1] === import.meta.filename) await main()
