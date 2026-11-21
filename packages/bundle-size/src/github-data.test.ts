import { describe, expect, it } from 'vite-plus/test'
import { artifacts, workflowRun } from './github-data.ts'

const run = {
  id: 1,
  run_attempt: 1,
  event: 'pull_request',
  workflow_id: 2,
  path: '.github/workflows/bundle-size.yml',
  status: 'completed',
  conclusion: null,
  display_title: 'Bundle size PR #92 to main',
  head_sha: 'a'.repeat(40),
  head_branch: 'feature',
  repository: { full_name: 'ktsn/liva' },
}

describe('GitHub response narrowing', () => {
  it('accepts absent fork associations and nullable completed-run fields', () => {
    const decoded = workflowRun(run)
    expect(decoded.head_repository).toBeNull()
    expect(decoded.pull_requests).toStrictEqual([])
    expect(decoded.conclusion).toBeNull()
  })

  it.each([undefined, null, 1, 'false'])(
    'does not interpret an invalid expiry flag as a live artifact: %j',
    (expired) => {
      expect(() =>
        artifacts({ artifacts: [{ id: 1, name: 'result', expired, size_in_bytes: 10 }] }),
      ).toThrow('Expected artifact expiry flag')
    },
  )
})
