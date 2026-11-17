import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('skipped title/body edits cannot enter the active measurement cancellation group', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/bundle-size.yml', import.meta.url),
    'utf8',
  )

  // GitHub evaluates workflow concurrency before job conditions. Only a runnable
  // measurement job may join its PR's cancellation group; a skipped edit must not.
  assert.doesNotMatch(workflow, /^concurrency:/m)
  assert.match(
    workflow,
    /^  measure:\n    if: .+\n    concurrency:\n      group: .+github\.event\.pull_request\.number.+\n      cancel-in-progress: true$/m,
  )
})
