import { describe, expect, it } from 'vite-plus/test'
import { CompletionGroup } from './completion-group.ts'

describe('current effect completion groups', () => {
  it('waits until all participants have registered and started', async () => {
    const group = new CompletionGroup()
    group.replace([], [1, 2])
    group.settle(1, 'completed')

    expect(group.isFinished).toBe(false)

    group.start()
    group.settle(2, 'completed')

    expect(await group.finished).toBe('completed')
  })

  it('ignores obsolete failures after atomic replacement', async () => {
    const group = new CompletionGroup()
    group.replace([], [1])
    group.start()

    group.replace([1], [2, 3])

    expect(group.settle(1, 'failed')).toBe(false)
    expect(group.isFinished).toBe(false)

    group.settle(2, 'completed')

    expect(group.isFinished).toBe(false)

    group.settle(3, 'completed')

    expect(await group.finished).toBe('completed')
  })

  it('finishes an empty or instant replacement', async () => {
    const group = new CompletionGroup()
    group.replace([], [1])
    group.start()
    group.replace([1], [])

    expect(await group.finished).toBe('completed')
  })

  it('fails when a currently applicable effect fails', async () => {
    const group = new CompletionGroup()
    group.replace([], [1, 2])
    group.start()

    expect(group.settle(9, 'failed')).toBe(false)
    expect(group.settle(1, 'failed')).toBe(true)
    expect(await group.finished).toBe('failed')
    expect(group.settle(2, 'completed')).toBe(false)
  })

  it.each(['superseded', 'owner-teardown'] as const)(
    'keeps the first %s result and rejects later membership',
    async (reason) => {
      const group = new CompletionGroup()
      group.replace([], [1])
      group.cancel(reason)

      group.replace([], [2])
      group.start()
      group.cancel('owner-teardown')

      expect(group.settle(1, 'completed')).toBe(false)
      expect(await group.finished).toBe(reason)
    },
  )

  it('can fail preparation before there are effect identifiers', async () => {
    const group = new CompletionGroup()

    group.fail()
    group.start()

    expect(await group.finished).toBe('failed')
  })

  it('completes an empty started group', async () => {
    const group = new CompletionGroup()

    group.start()

    expect(await group.finished).toBe('completed')
  })
})
