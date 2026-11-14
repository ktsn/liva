import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LifecycleSession, resolveLifecycle, type LifecycleWork } from './lifecycle.ts'
import { PropertyMotion } from '../motion/property-motion.ts'
import { evaluate } from '../evaluation/expression.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import type { Timing } from '../model/definition.ts'

const elements: HTMLElement[] = []
const sessions: LifecycleSession[] = []

function setup(
  phase: 'enter' | 'leave',
  timing: Timing = { kind: 'tween', durationMs: 30, easing: 'linear' },
) {
  const element = document.createElement('div')

  element.style.opacity = '0.7'
  document.body.append(element)
  elements.push(element)

  const work: LifecycleWork[] = [
    {
      element,
      track: {
        target: 'box',
        property: 'opacity',
        timing,
        keyframes: [
          { offset: 0, value: '0' },
          { offset: 1, value: '1' },
        ],
        destinationValue: '1',
      },
    },
  ]
  const errors: unknown[] = []
  const session = new LifecycleSession(work, phase, (error) => errors.push(error))

  sessions.push(session)

  return { element, session, errors }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.cancel('owner-teardown')

  for (const element of elements.splice(0)) element.remove()
})

describe('lifecycle effects', () => {
  it.each(['enter', 'leave'] as const)(
    'Instant %s completes without leaving effects or ownership',
    async (phase) => {
      const timing = timingValue(evaluate({ kind: 'reference', path: ['instant'] }, {}))
      const { element, session } = setup(phase, timing)

      session.initialize()
      session.play()

      expect(await session.finished).toBe('completed')
      expect(element.getAnimations()).toEqual([])
      expect(session.owns(element, 'opacity')).toBe(false)
      expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    },
  )

  it.each(['enter', 'leave'] as const)('completes %s and releases effects', async (phase) => {
    const { element, session } = setup(phase)

    expect(session.owns(element, 'opacity')).toBe(true)
    expect(session.owns(element, 'scale')).toBe(false)

    session.initialize()
    session.initialize()

    expect(element.style.opacity).toBe('0')

    session.play()
    session.play()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    expect(element.getAnimations()).toEqual([])
    expect(session.owns(element, 'opacity')).toBe(false)

    session.initialize()
    session.play()
  })

  it.each(['superseded', 'owner-teardown'] as const)('restores styles when %s', async (reason) => {
    const { element, session } = setup('enter')

    session.initialize()
    session.play()
    session.cancel(reason)

    expect(await session.finished).toBe(reason)
    expect(element.style.opacity).toBe('0.7')
    expect(element.getAnimations()).toEqual([])
  })

  it('reports cancelled browser effects as failed', async () => {
    const { element, session } = setup('leave')

    session.initialize()
    session.play()
    element.getAnimations()[0].cancel()

    expect(await session.finished).toBe('failed')
    expect(element.style.opacity).toBe('0.7')
  })

  it('settles zero-duration work and rejects invalid animation timing', async () => {
    const zero = setup('enter', { kind: 'tween', durationMs: 0, easing: 'linear' })

    zero.session.initialize()
    zero.session.play()

    expect(await zero.session.finished).toBe('completed')
    expect(zero.element.style.opacity).toBe('1')

    const invalid = setup('enter', { kind: 'tween', durationMs: -1, easing: 'linear' })

    invalid.session.initialize()
    invalid.session.play()

    expect(await invalid.session.finished).toBe('failed')
    expect(invalid.element.style.opacity).toBe('0.7')
    expect(invalid.errors[0]).toBeInstanceOf(Error)
  })

  it('plays spring timing', async () => {
    const { element, session } = setup('enter', {
      kind: 'spring-duration',
      durationMs: 20,
      bounce: 0.2,
    })

    session.initialize()
    session.play()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
  })

  it('captures connected and detached presentation while skipping absent targets', () => {
    const { element } = setup('leave')
    const transition = {
      timing: { kind: 'tween', durationMs: 20, easing: 'linear' } as const,
      targets: [{ name: 'box', properties: [{ name: 'opacity' }] }],
    }
    const state = { name: 'on', targets: [] }

    expect(resolveLifecycle('leave', transition, state, new Map())).toEqual([])
    expect(
      resolveLifecycle('leave', transition, state, new Map([['box', element]]))[0].track
        .keyframes[0].value,
    ).toBe('0.7')

    element.remove()

    expect(
      resolveLifecycle('leave', transition, state, new Map([['box', element]]))[0].track
        .keyframes[0].value,
    ).toBe('0.7')
  })

  it('reports simultaneous current-effect failures once and releases every standalone effect', async () => {
    const element = document.createElement('div')
    element.style.cssText = 'opacity:0.7;scale:0.8;'
    document.body.append(element)
    const errors: unknown[] = []
    const work = ['opacity', 'scale'].map((property) => ({
      element,
      track: {
        target: 'box',
        property,
        timing: { kind: 'tween' as const, durationMs: 100, easing: 'linear' },
        keyframes: [
          { offset: 0, value: '0' },
          { offset: 1, value: '1' },
        ],
        destinationValue: '1',
      },
    }))
    const session = new LifecycleSession(work, 'leave', (error) => errors.push(error))

    try {
      session.play()

      for (const animation of element.getAnimations()) animation.cancel()

      expect(await session.finished).toBe('failed')
      expect(errors).toHaveLength(1)
      expect(element.style.opacity).toBe('0.7')
      expect(element.style.scale).toBe('0.8')
      expect(element.getAnimations()).toEqual([])
    } finally {
      session.cancel('owner-teardown')
      element.remove()
    }
  })

  it('retains a detached-owner native effect after reference preparation failure and recovers later', async () => {
    const element = document.createElement('div')
    element.style.cssText = 'width:40px;height:20px;translate:0px;'
    document.body.append(element)
    const errors: unknown[] = []
    const session = new LifecycleSession(
      [
        {
          element,
          track: {
            target: 'box',
            property: 'translate',
            timing: { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
            keyframes: [
              { offset: 0, value: '0px' },
              { offset: 1, value: '50%' },
            ],
            destinationValue: '50%',
          },
        },
      ],
      'leave',
      (error) => errors.push(error),
    )
    const failure = new Error('reference observation failed')
    let restoreRead: (() => void) | undefined

    try {
      session.play()
      const original = element.getAnimations()[0]
      await original.ready
      const read = vi.spyOn(PropertyMotion.prototype, 'read').mockImplementation(() => {
        throw failure
      })
      restoreRead = () => read.mockRestore()
      element.style.width = '80px'

      await vi.waitFor(() => expect(errors).toContain(failure))

      expect(element.getAnimations()).toContain(original)
      expect(session.isFinished).toBe(false)
      read.mockRestore()

      await vi.waitFor(() => expect(element.getAnimations()).not.toContain(original))

      for (const animation of element.getAnimations()) animation.finish()

      expect(await session.finished).toBe('completed')
      expect(element.style.translate).toBe('0px')
      expect(element.getAnimations()).toEqual([])
    } finally {
      restoreRead?.()
      session.cancel('owner-teardown')
      element.remove()
    }
  })
})
