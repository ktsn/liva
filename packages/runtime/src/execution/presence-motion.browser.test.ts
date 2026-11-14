import { describe, expect, it } from 'vite-plus/test'
import { LivaInstance } from './instance.ts'
import { LifecycleSession } from './lifecycle.ts'
import { presenceCases } from '../../../../tests/browser/presence-cases.ts'

describe('shared presence layer execution', () => {
  it('retargets enter with ordinary timing without settling obsolete effects', async () => {
    const result = await presenceCases.retarget()

    expect(result).toMatchObject({
      start: '0.25',
      sampled: '0.25',
      initialDuration: 400,
      duration: 80,
      end: '0.6',
      premature: false,
      result: 'completed',
      final: '0.6',
      diagnostics: 0,
      failures: 0,
    })
    expect(result.composition).toEqual({ layers: { base: true, selected: true }, states: {} })
  })

  it('uses property, authored-target and phase timing precedence', async () => {
    expect(await presenceCases.timing()).toEqual([160, 240, 400])
  })

  it('keeps leave expressions live while preserving replacement completion', async () => {
    const result = await presenceCases.liveLeave()

    expect(result).toEqual({
      start: '0.8',
      initial: '0.8',
      end: '0.6',
      premature: false,
      result: 'completed',
      errors: 0,
    })
  })

  it.each([false, true])(
    'retains the final input environment after disposal (detached=%s)',
    async (detached) => {
      expect(await presenceCases.detachedEnvironment(detached)).toEqual({
        end: '0.6',
        result: 'completed',
        sourceReleased: true,
        remaining: 0,
        errors: 0,
      })
    },
  )

  it('hands ordinary spring momentum into leave and back through spread-based reentry', async () => {
    const result = await presenceCases.momentum()

    // Browser serialization follows the repository's 0.1px spring translation contract.
    expect(Math.abs(result.leaveStart - result.ordinary)).toBeLessThan(0.1)
    expect(result.leaveNext).toBeGreaterThan(result.leaveStart)
    expect(Math.abs(result.enterStart - result.returning)).toBeLessThan(0.1)
    expect(result.enterNext).toBeLessThan(result.enterStart)
    expect(result.result).toBe('completed')
    expect(result.errors).toBe(0)
  })

  it('preserves a new ordinary update between native settlement and group cleanup', async () => {
    expect(await presenceCases.settledGap()).toEqual({ retained: true, result: '0.6', errors: 0 })
  })

  it('evaluates the enter initial frame at initialization after a parameter change', async () => {
    expect(await presenceCases.freshStart()).toEqual({
      initialized: '0.3',
      first: '0.3',
      errors: 0,
    })
  })

  it.each([false, true])(
    'keeps original direct-input expiry across capture and release (expired=%s)',
    async (expired) => {
      const result = await presenceCases.directHandoff(expired, false)

      expect(result.start).toBe(10)
      expect(result.errors).toBe(0)

      expect(Math.sign(result.next - result.start)).toBe(expired ? -1 : 1)
    },
  )

  it('prefers a newer controller-release sample over an older captured derivative', async () => {
    const result = await presenceCases.directHandoff(false, true)

    expect(result.start).toBe(-30)
    expect(result.next).toBeLessThan(result.start)
    expect(result.errors).toBe(0)
  })

  it('applies unowned ordinary updates without replacing the leave-owned effect', async () => {
    expect(await presenceCases.lowerUpdates()).toEqual({
      retained: true,
      before: '0.75',
      after: '0.75',
      scale: '1.5',
      errors: 0,
    })
  })

  it('retargets a relative reference without completing the current group', async () => {
    expect(await presenceCases.relativeRetarget()).toEqual({
      changed: true,
      end: '40px',
      premature: false,
      historyStable: true,
      guardActive: true,
      errors: 0,
    })
  })

  it.each([false, true])(
    'keeps the authored spring endpoint distinct from ordinary completion (presence=%s)',
    async (presence) => {
      const result = await presenceCases.authoredEndpoint(presence)

      expect(result.incoming).toBeGreaterThan(0)
      expect(result.last).toBe('50px')
      expect(Math.abs(result.start - result.incoming)).toBeLessThan(0.1)
      expect(result.final).toBe(presence ? '100px' : '200px')
      expect(result.diagnostics).toEqual(presence ? [] : ['runtime.endpoint'])
      expect(result.failures).toBe(0)
    },
  )

  it('joins replacement membership across repeated targets and multiple Motion owners', async () => {
    expect(await presenceCases.multiOwner()).toEqual({
      premature: false,
      endpoints: ['0.6', '0.6'],
      result: 'completed',
      remaining: 0,
      errors: 0,
    })
  })

  it.each([false, true])(
    'keeps captured DOM-write velocity on its original expiry after owner disposal (expired=%s)',
    async (expired) => {
      const result = await presenceCases.directExpiry(expired)

      expect(result.start).toBe(10)
      expect(Math.sign(result.next - result.start)).toBe(expired ? -1 : 1)
      expect(result.errors).toBe(0)
    },
  )

  it.each(['exact', 'component', 'enter'] as const)(
    'releases a target-wide controller obscured by presence and reacquires on cancellation (mode=%s)',
    async (mode) => {
      expect(await presenceCases.controllerOwnership(mode)).toEqual({
        retained: true,
        unchanged: true,
        otherStable: true,
        increment: 10,
        errors: 0,
      })
    },
  )

  it('preserves custom spread-based work and ignores unrelated instance retain requests', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const timing = { kind: 'tween', durationMs: 100, easing: 'linear' } as const
    const instance = new LivaInstance({
      name: 'custom',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
          ],
        },
      ],
      enter: {
        timing,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }],
              },
            ],
          },
        ],
      },
    })
    instance.bind([['box', element]])

    expect(instance.captureLifecycle('enter', ['absent'], element)).toEqual([])
    const work = instance.captureLifecycle('enter', ['box'], element).map((item) => ({
      ...item,
      track: {
        ...item.track,
        property: 'scale',
        keyframes: [
          { offset: 0, value: '0.5' },
          { offset: 1, value: '1' },
        ],
      },
    }))
    const extra = {
      element,
      track: {
        target: 'outside',
        property: 'translate',
        timing,
        keyframes: [
          { offset: 0, value: '10px' },
          { offset: 1, value: '0px' },
        ],
        destinationValue: '0px',
      },
    }
    const session = new LifecycleSession([...work, extra], 'enter')

    try {
      // The live executor takes its receiver's work; the unmatched item retains a
      // standalone owner. Repeated retention before initialization is idempotent.
      instance.retainLifecycle('enter', session)
      instance.retainLifecycle('enter', session)
      session.play()

      for (const animation of element.getAnimations()) animation.finish()

      expect(await session.finished).toBe('completed')
      expect(element.style.scale).toBe('')
      expect(element.style.translate).toBe('0px')
      expect(element.getAnimations()).toEqual([])
    } finally {
      session.cancel('owner-teardown')
      instance.dispose()
      element.remove()
    }
  })

  it.each([false, true])(
    'retargets a retained relative reference in either animation or completion (completion=%s)',
    async (completion) => {
      expect(await presenceCases.relativeRole(completion)).toEqual({
        changed: true,
        end: completion ? '50px' : '40px',
        result: 'completed',
        final: '0px',
        errors: 0,
      })
    },
  )

  it('keeps an active leave on its retained definition environment during source replacement', async () => {
    expect(await presenceCases.replacementDuringLeave()).toEqual({
      retained: true,
      end: '0.2',
      scale: '1.5',
      result: 'completed',
      errors: 0,
    })
  })

  it('preserves unrelated inset component effects during an alias-overlapping presence handoff', async () => {
    const result = await presenceCases.shorthandHandoff()

    expect(Math.abs(result.start - result.incoming)).toBeLessThan(0.1)
    expect(result.next).toBeGreaterThan(result.start)
    expect(result.remainingOrdinary).toBe(3)
    expect(result.result).toBe('completed')
    expect(result.errors).toBe(0)
  })

  it('continues phase and unowned ordinary planning while the receiver is detached', async () => {
    const result = await presenceCases.detachedLive()

    expect(result.endpoints).toEqual(
      expect.arrayContaining([
        { opacity: '0.6', scale: undefined },
        { opacity: undefined, scale: '2' },
      ]),
    )
    expect(result.result).toBe('completed')
    expect(result.errors).toBe(0)
  })

  it('preserves scalar browser spring interpolation for unsupported numeric color', async () => {
    expect(await presenceCases.unsupportedColor()).toEqual({
      count: 2,
      endpoint: 'blue',
      result: 'completed',
      final: 'red',
      errors: 0,
    })
  })

  it('allows declared leave work to obscure an unreadable detached binding without a fallback style', async () => {
    const element = document.createElement('div')
    element.style.width = 'auto'
    const diagnostics: unknown[] = []
    const instance = new LivaInstance(
      {
        name: 'unreadable',
        letBindings: [
          {
            name: 'movement',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [{ name: 'input', value: { kind: 'number', value: 0 } }],
            },
          },
        ],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  {
                    name: 'width',
                    value: {
                      kind: 'binding',
                      expression: { kind: 'reference', path: ['movement'] },
                    },
                  },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'width',
                  keyframes: [
                    { offset: 0, value: { kind: 'literal', value: '10px' } },
                    { offset: 1, value: { kind: 'literal', value: '0px' } },
                  ],
                },
              ],
            },
          ],
        },
      },
      {},
      (diagnostic) => diagnostics.push(diagnostic),
    )
    instance.bind([['box', element]])
    const session = new LifecycleSession(
      instance.captureLifecycle('leave', ['box'], element),
      'leave',
    )

    try {
      session.initialize()
      instance.retainLifecycle('leave', session)
      session.play()
      instance.updateParameters({})
      session.cancel('owner-teardown')

      expect(await session.finished).toBe('owner-teardown')
      expect(element.style.width).toBe('auto')
      expect(element.getAnimations()).toEqual([])
      expect(diagnostics).toEqual([])
    } finally {
      session.cancel('owner-teardown')
      instance.dispose()
    }
  })

  it('supersedes enter before opening an isolated manual composition preview', async () => {
    expect(await presenceCases.previewDuringEnter()).toEqual({
      result: 'superseded',
      manual: 1,
      paused: true,
      remaining: 0,
      final: '1',
      errors: 0,
    })
  })

  it('rejects invalid live phase timing before acceptance and retargets a later valid timing-only change', async () => {
    expect(await presenceCases.timingUpdateValidation()).toEqual({
      retained: true,
      rejectedNotifications: 0,
      notifications: 1,
      start: '0.75',
      duration: 200,
      result: 'completed',
      diagnostics: 1,
      failures: 0,
    })
  })

  it('samples a still-live trajectory at final planning time instead of replaying capture-time velocity', async () => {
    const result = await presenceCases.laterTrajectory()

    expect(Math.abs(result.start - result.latest)).toBeLessThan(0.1)
    expect(result.next).toBeLessThan(result.start)
    expect(result.result).toBe('completed')
    expect(result.errors).toBe(0)
  })

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, false],
    [false, true, true],
  ])(
    'cleans failed live preparation without changing its first result (explicit=%s disposed=%s existing=%s)',
    async (explicit, disposed, existing) => {
      expect(await presenceCases.failedPreparation(explicit, disposed, existing)).toEqual({
        result: 'failed',
        stillFailed: 'failed',
        reports: 1,
        causePreserved: true,
        explicitThrew: explicit,
        message: 'Tween duration must be non-negative milliseconds',
        remainingListeners: 0,
        remainingEffects: 0,
        diagnostics: 0,
        continued: true,
        continuingResult: 'completed',
      })
    },
  )

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'retires disposed receiver ownership before later captured work (concurrent=%s complete=%s)',
    async (concurrent, complete) => {
      expect(await presenceCases.retiredOwnership(concurrent, complete)).toEqual({
        firstRestored: '0.3',
        external: '0.8',
        other: concurrent ? '0.4' : '0.3',
        result: complete ? 'completed' : 'owner-teardown',
        remaining: 0,
        diagnostics: 0,
      })
    },
  )

  it.each([false, true])(
    'retires a restored property while another property still leaves (complete=%s)',
    async (complete) => {
      expect(await presenceCases.retiredProperty(complete)).toEqual({
        restored: '0.3',
        opacity: '0',
        scale: '0.4',
        result: complete ? 'completed' : 'owner-teardown',
        remaining: 0,
      })
    },
  )

  it.each(
    (['x', 'y'] as const).flatMap((axis) =>
      (['fresh', 'near-expiry', 'boundary', 'stationary'] as const).map((mode) => ({ axis, mode })),
    ),
  )('retains newest released $axis velocity through disposal at $mode', async ({ axis, mode }) => {
    expect(await presenceCases.releasedAfterDisposal(axis, mode)).toEqual({
      start: 10,
      direction: mode === 'boundary' ? 1 : -1,
      other: 0,
      result: 'completed',
      errors: 0,
    })
  })

  it.each(['takeover', 'remaining', 'mixed', 'ordered'] as const)(
    'validates only applicable enter declarations without changing rejected state ($mode=%s)',
    async (mode) => {
      expect(await presenceCases.candidateApplicability(mode)).toEqual({
        firstAccepted: mode === 'takeover' || mode === 'ordered',
        rejectedHistory: mode === 'takeover' || mode === 'ordered' ? 'next' : 'idle',
        retryRetained: true,
        durations:
          mode === 'mixed' ? [80, 80] : [mode === 'takeover' || mode === 'ordered' ? 80 : 400],
        history: mode === 'remaining' ? 'idle' : 'next',
        result: 'completed',
        diagnostics: mode === 'takeover' || mode === 'ordered' ? 0 : 1,
        failures: 0,
        final: mode === 'ordered' ? '200px' : mode === 'remaining' ? '1' : '0.9',
      })
    },
  )

  it.each(['physical', 'logical', 'repeated'] as const)(
    'takes over only affected enter components and preserves the current barrier (mode=%s)',
    async (mode) => {
      const count = mode === 'repeated' ? 2 : 1

      expect(await presenceCases.canonicalTakeover(mode)).toEqual({
        start: Array(count).fill('75px'),
        ends: Array(count).fill('200px'),
        durations: Array(count).fill(80),
        preserved: true,
        premature: false,
        result: 'completed',
        final: Array(count).fill('200px'),
        remaining: 0,
        diagnostics: 0,
      })
    },
  )

  it('does not observe unchanged canonical presence during unrelated input updates', async () => {
    expect(await presenceCases.unchangedCanonicalObservation()).toEqual({
      reads: 0,
      preserved: true,
      result: 'completed',
    })
  })

  it('retains authored relative-reference observation after phase canonicalization', async () => {
    expect(await presenceCases.canonicalReference()).toEqual({
      changed: true,
      left: '40px',
      top: '10px',
      result: 'completed',
      diagnostics: 0,
    })
  })
})
