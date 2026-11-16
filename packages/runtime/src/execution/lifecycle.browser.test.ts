import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LifecycleSession, resolveLifecycle, type LifecycleWork } from './lifecycle.ts'
import { evaluate } from '../evaluation/expression.ts'
import { PropertyMotion } from '../motion/property-motion.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import { LivaInstance } from './instance.ts'
import type { Definition, Timing } from '../model/definition.ts'

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

  return { element, session, errors, work }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.cancel('owner-teardown')

  for (const element of elements.splice(0)) element.remove()
})

describe('lifecycle effects', () => {
  it.each(['completed', 'cancelled'] as const)(
    'releases disposed retain registrations when empty leave work is %s',
    async (ending) => {
      const media = matchMedia('(prefers-reduced-motion: reduce)')
      const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
      const added = vi.spyOn(media, 'addEventListener')
      const removed = vi.spyOn(media, 'removeEventListener')
      const instance = new LivaInstance({ name: 'empty', layers: [] })
      const session = new LifecycleSession(instance.captureLifecycle('leave', []), 'leave')

      sessions.push(session)
      instance.retainLifecycle('leave', session)

      try {
        if (ending === 'completed') session.play()

        instance.dispose()

        expect(removed).not.toHaveBeenCalled()

        if (ending === 'cancelled') session.cancel('owner-teardown')

        expect(await session.finished).toBe(ending === 'completed' ? 'completed' : 'owner-teardown')

        for (const registration of added.mock.calls)
          expect(removed).toHaveBeenCalledWith(...registration)
      } finally {
        session.cancel('owner-teardown')
        instance.dispose()
        added.mockRestore()
        removed.mockRestore()
        factory.mockRestore()
      }
    },
  )

  it('releases disposed retain registrations when externally owned leave work completes', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const added = vi.spyOn(media, 'addEventListener')
    const removed = vi.spyOn(media, 'removeEventListener')
    const instance = new LivaInstance({ name: 'external', layers: [] })
    const { element, session, errors } = setup('leave', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })

    instance.retainLifecycle('leave', session)

    try {
      session.play()
      instance.dispose()

      expect(removed).not.toHaveBeenCalled()
      expect(session.isFinished).toBe(false)

      element.getAnimations()[0].finish()

      expect(await session.finished).toBe('completed')

      for (const registration of added.mock.calls)
        expect(removed).toHaveBeenCalledWith(...registration)

      expect(element.style.opacity).toBe('0.7')
      expect(errors).toEqual([])
    } finally {
      session.cancel('owner-teardown')
      instance.dispose()
      added.mockRestore()
      removed.mockRestore()
      factory.mockRestore()
    }
  })

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

  it.each([true, false])(
    'honors standalone restoreOnCompletion=%s',
    async (restoreOnCompletion) => {
      const { element, work } = setup('enter', {
        kind: 'tween',
        durationMs: 0,
        easing: 'linear',
      })
      const session = new LifecycleSession(
        work.map((item) => ({ ...item, restoreOnCompletion })),
        'enter',
      )

      sessions.push(session)

      session.play()

      expect(await session.finished).toBe('completed')
      expect(element.style.opacity).toBe(restoreOnCompletion ? '0.7' : '1')
      expect(element.getAnimations()).toEqual([])
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

  it.each(['initialize', 'play'] as const)(
    'preserves the original error and releases failed %s initialization',
    async (operation) => {
      const { element, session, errors } = setup('enter')
      const failure = new Error('initial style write failed')
      const write = vi.spyOn(element.style, 'setProperty').mockImplementationOnce(() => {
        throw failure
      })

      try {
        let thrown: unknown

        try {
          session[operation]()
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBe(operation === 'initialize' ? failure : undefined)
        expect(await session.finished).toBe('failed')
        expect(errors).toEqual([failure])
        expect(element.getAnimations()).toEqual([])
      } finally {
        write.mockRestore()
      }
    },
  )

  it.each([
    { operation: 'initialize', index: 0 },
    { operation: 'initialize', index: 1 },
    { operation: 'play', index: 0 },
    { operation: 'play', index: 1 },
  ] as const)(
    'cleans every owner after participant $index fails during $operation',
    async ({ operation, index }) => {
      const definition: Definition = {
        name: 'grouped-failure',
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
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
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
      }
      const owners = Array.from({ length: 2 }, () => {
        const element = document.createElement('div')

        document.body.append(element)
        elements.push(element)

        const instance = new LivaInstance(definition)

        instance.bind([['box', element]])

        return { instance, element }
      })
      const failures: unknown[] = []
      const session = new LifecycleSession(
        owners.flatMap(({ instance }) => instance.captureLifecycle('enter', ['box'])),
        'enter',
        (error) => failures.push(error),
      )

      sessions.push(session)

      const failure = new Error('participant preparation failed')
      const OriginalAnimation = window.Animation
      let restore: () => void

      if (operation === 'initialize') {
        const write = vi
          .spyOn(owners[index].element.style, 'setProperty')
          .mockImplementationOnce(() => {
            throw failure
          })

        restore = () => write.mockRestore()
      } else {
        session.initialize()

        const create = vi.spyOn(window, 'Animation')

        if (index === 1)
          create.mockImplementationOnce(function (effect, timeline) {
            return new OriginalAnimation(effect, timeline)
          })

        create.mockImplementationOnce(function () {
          throw failure
        })
        restore = () => create.mockRestore()
      }

      try {
        let thrown: unknown

        try {
          session[operation]()
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBe(operation === 'initialize' ? failure : undefined)
        expect(await session.finished).toBe('failed')
        expect(failures).toEqual([failure])

        for (const { element, instance } of owners) {
          expect(element.style.opacity).toBe('1')
          expect(element.getAnimations()).toEqual([])
          expect(instance.animations).toEqual([])
        }
      } finally {
        restore()

        for (const { instance } of owners) instance.dispose()
      }
    },
  )

  it('reports restoration failures while releasing effects and the boundary result', async () => {
    const { element, session, errors } = setup('leave')

    session.initialize()
    session.play()

    const failure = new Error('restoration failed')
    const write = vi.spyOn(element.style, 'cssText', 'set').mockImplementationOnce(() => {
      throw failure
    })

    try {
      session.cancel('owner-teardown')

      expect(await session.finished).toBe('owner-teardown')
      expect(element.getAnimations()).toEqual([])
      expect(errors).toEqual([failure])
    } finally {
      write.mockRestore()
    }
  })

  it('stops participant startup if initialization cancels the operation', async () => {
    const { work } = setup('enter')
    let played = false
    const session = new LifecycleSession(
      work.map((item) => ({
        ...item,
        playback: {
          initializeLifecycle(owner) {
            owner.cancel('owner-teardown')
          },

          playLifecycle() {
            played = true
          },

          endLifecycle() {},
        },
      })),
      'enter',
    )

    sessions.push(session)

    session.play()

    expect(await session.finished).toBe('owner-teardown')
    expect(played).toBe(false)
  })

  it('keeps allowed authored standalone endpoints distinct from their completion value', async () => {
    const { work, element } = setup('enter')
    const errors: unknown[] = []
    const session = new LifecycleSession(
      work.map((item) => ({
        ...item,
        track: {
          ...item.track,
          keyframes: [
            { offset: 0, value: '0' },
            { offset: 1, value: '0.6' },
          ],
        },
      })),
      'enter',
      (error) => errors.push(error),
    )

    sessions.push(session)

    session.initialize()
    session.play()
    element.getAnimations()[0].finish()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('fails standalone relative playback if reference retarget observation fails', async () => {
    const { work, element } = setup('leave', {
      kind: 'spring-duration',
      durationMs: 1000,
      bounce: 0.1,
    })

    element.style.cssText = 'width:100px;translate:0px;'

    const errors: unknown[] = []
    const session = new LifecycleSession(
      work.map((item) => ({
        ...item,
        track: {
          ...item.track,
          property: 'translate',
          destinationValue: '100%',
          keyframes: [
            { offset: 0, value: '0px' },
            { offset: 1, value: '100%' },
          ],
        },
      })),
      'leave',
      (error) => errors.push(error),
    )

    sessions.push(session)
    session.initialize()
    session.play()

    const failure = new Error('motion observation failed')
    const observe = vi.spyOn(PropertyMotion.prototype, 'read').mockImplementationOnce(() => {
      throw failure
    })

    try {
      element.style.width = '200px'

      expect(await session.finished).toBe('failed')
      expect(element.getAnimations()).toEqual([])
      expect(errors).toEqual([failure])
    } finally {
      observe.mockRestore()
    }
  })

  it('settles standalone leave on media changes without restarting on a non-reduced notification', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const query = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const { element, session } = setup('leave', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })

    try {
      session.initialize()
      session.play()

      const animation = element.getAnimations()[0]

      media.dispatchEvent(new Event('change'))

      expect(element.getAnimations()).toContain(animation)

      const reduced = vi.spyOn(media, 'matches', 'get').mockReturnValue(true)

      try {
        media.dispatchEvent(new Event('change'))

        expect(await session.finished).toBe('completed')
        expect(element.getAnimations()).toEqual([])
      } finally {
        reduced.mockRestore()
      }
    } finally {
      query.mockRestore()
    }
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
})
