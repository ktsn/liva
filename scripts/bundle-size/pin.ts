import { environment, number, object, text } from './data.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

/** Pin synchronously: fetchRef must finish before resolveFetch reads FETCH_HEAD.
 * Only this process receives the read token; install/build steps run later. */
export function pin(event: unknown, fetchRef: (ref: string) => void, resolveFetch: () => string) {
  const pr = object(object(event).pull_request)
  const baseRef = text(object(pr.base).ref)
  const headSha = text(object(pr.head).sha)

  const prNumber = number(pr.number)

  fetchRef(`refs/heads/${baseRef}`)

  const base = resolveFetch()

  fetchRef(`refs/pull/${prNumber}/head`)

  const head = resolveFetch()

  assert.equal(head, headSha, 'PR changed before measurement started')

  return { base, head, pr: prNumber, baseBranch: baseRef }
}

/** Pass authentication as process-scoped Git config; never write it to repository config. */
export function readOnlyGitEnvironment(
  token: string,
  server: string,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...parentEnvironment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

async function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request')

  const event: unknown = JSON.parse(await readFile(environment('GITHUB_EVENT_PATH'), 'utf8'))
  const token = process.env.BUNDLE_SIZE_READ_TOKEN

  assert(token, 'Missing read-only fetch token')

  const gitEnvironment = readOnlyGitEnvironment(token, environment('GITHUB_SERVER_URL'))
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
