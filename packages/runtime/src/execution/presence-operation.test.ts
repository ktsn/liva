import { describe, expect, it, vi } from 'vite-plus/test'
import {
  createPresenceCapture,
  PresenceOperation,
  type PresenceParticipant,
} from './presence-operation.ts'

function participant(log: string[], name: string): PresenceParticipant {
  return {
    release() {
      log.push(`${name}:release`)
    },
    initialize() {
      log.push(`${name}:initialize`)
    },
    play() {
      log.push(`${name}:play`)
    },
    end(_operation, result) {
      log.push(`${name}:${result}`)
    },
  }
}

describe('PresenceOperation', () => {
  it('releases all participants before superseding and initializing, deduplicating capture identities', async () => {
    const log: string[] = []
    const previous = new PresenceOperation(
      [createPresenceCapture(participant(log, 'previous'), 'enter')],
      'enter',
    )
    const first = createPresenceCapture(participant(log, 'first'), 'leave')
    const second = createPresenceCapture(participant(log, 'second'), 'leave')
    const next = new PresenceOperation([first, second, first], 'leave')

    next.initialize(previous)
    next.play()
    next.play()

    expect(log).toEqual([
      'first:release',
      'second:release',
      'previous:superseded',
      'first:initialize',
      'second:initialize',
      'first:play',
      'second:play',
    ])
    expect(next.isFinished).toBe(false)

    expect(await previous.finished).toBe('superseded')
    expect(await next.finished).toBe('completed')
  })

  it('keeps completion open through startup and follows only current effect identifiers', async () => {
    const log: string[] = []
    const owner = participant(log, 'owner')
    owner.play = (operation) => operation.completion.replace([], [1])
    const operation = new PresenceOperation([createPresenceCapture(owner, 'enter')], 'enter')

    operation.initialize()

    await Promise.resolve()

    expect(operation.isFinished).toBe(false)

    operation.play()
    operation.completion.replace([1], [2])
    operation.completion.replace([1], [])

    await Promise.resolve()

    expect(operation.isFinished).toBe(false)

    operation.completion.replace([2], [])

    expect(await operation.finished).toBe('completed')
  })

  it.each(['initialize', 'play'] as const)(
    'stops remaining startup after cancellation during %s',
    async (phase) => {
      const log: string[] = []
      const first = participant(log, 'first')
      first[phase] = (operation) => operation.cancel('owner-teardown')
      const second = participant(log, 'second')
      const operation = new PresenceOperation(
        [createPresenceCapture(first, 'enter'), createPresenceCapture(second, 'enter')],
        'enter',
      )

      operation.play()

      expect(await operation.finished).toBe('owner-teardown')
      expect(log).not.toContain(`second:${phase}`)
    },
  )

  it('rejects invalid capture identities and mismatched phases before browser work', () => {
    const log: string[] = []
    const capture = createPresenceCapture(participant(log, 'owner'), 'enter')

    expect(() => Reflect.construct(PresenceOperation, [[{}], 'enter'])).toThrow(
      'Unknown presence capture',
    )
    expect(() => new PresenceOperation([capture], 'leave')).toThrow('phase does not match')
    expect(log).toEqual([])
  })

  it('reports failures once and ignores repeated termination or later startup', async () => {
    const log: string[] = []
    const report = vi.fn<(error: unknown) => void>()
    const failure = new Error('Participant failed')
    const operation = new PresenceOperation(
      [createPresenceCapture(participant(log, 'owner'), 'leave')],
      'leave',
      report,
    )

    operation.fail(failure)
    operation.fail(failure)
    operation.cancel('superseded')
    operation.initialize()
    operation.play()

    expect(await operation.finished).toBe('failed')
    expect(log).toEqual(['owner:failed'])
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  })
})
