import { describe, expect, it } from 'vite-plus/test'
import { CompletionGroup } from './completion-group.ts'

describe('current effect completion', () => {
  it('joins participants before completing empty work, once only', async () => {
    const results: string[] = []
    const group = new CompletionGroup('completed', (result) => results.push(result))

    group.replace([], [])

    await Promise.resolve()

    expect(results).toEqual([])

    group.seal()
    group.seal()

    await Promise.resolve()

    expect(results).toEqual(['completed'])
  })

  it('waits for replacement effects and ignores stale settlement of removed IDs', async () => {
    const results: string[] = []
    const group = new CompletionGroup('completed', (result) => results.push(result))

    group.replace([], [1, 2])
    group.seal()
    group.replace([1], [3])
    group.replace([1, 2], [])

    await Promise.resolve()

    expect(results).toEqual([])

    group.replace([3], [])
    group.replace([], [4])

    await Promise.resolve()

    expect(results).toEqual([])

    group.replace([4], [])

    await Promise.resolve()

    expect(results).toEqual(['completed'])
  })

  it('settles failure or cancellation idempotently before queued completion', async () => {
    const results: string[] = []
    const group = new CompletionGroup<'completed' | 'failed'>('completed', (result) =>
      results.push(result),
    )

    group.seal()
    group.end('failed')
    group.end('completed')
    group.replace([], [1])
    group.seal()

    await Promise.resolve()

    expect(results).toEqual(['failed'])
  })
})
