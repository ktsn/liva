import { capturePresence } from '../__test__/helpers/presence.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { PresenceOperation, createPresenceCapture } from './presence-operation.ts'
import { evaluate } from '../evaluation/expression.ts'
import { PropertyMotion } from '../motion/property-motion.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import { LivaInstance } from './instance.ts'
import { Runtime } from './runtime.ts'
import { PresentationExecutor } from './presentation-executor.ts'
import type { Definition, Timing } from '../model/definition.ts'

const elements: HTMLElement[] = []
const sessions: PresenceOperation[] = []
const instances: LivaInstance[] = []

function setup(
  phase: 'enter' | 'leave',
  timing: Timing = { kind: 'tween', durationMs: 30, easing: 'linear' },
  options: {
    property?: string
    start?: string
    end?: string
    baseline?: string
    style?: string
  } = {},
) {
  const element = document.createElement('div')
  const property = options.property ?? 'opacity'
  const baseline = options.baseline ?? (phase === 'enter' ? '1' : '0.7')

  element.style.cssText = options.style ?? 'opacity:0.7'
  document.body.append(element)
  elements.push(element)

  const definition: Definition = {
    name: 'captured-effects',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'box',
            properties: [{ name: property, value: { kind: 'literal', value: baseline } }],
          },
        ],
      },
    ],
    [phase]: {
      timing,
      targets: [
        {
          name: 'box',
          properties: [
            {
              name: property,
              keyframes: [
                { offset: 0, value: { kind: 'literal', value: options.start ?? '0' } },
                { offset: 1, value: { kind: 'literal', value: options.end ?? '1' } },
              ],
            },
          ],
        },
      ],
    },
  }
  const instance = new LivaInstance(definition)

  instances.push(instance)
  instance.bind([['box', element]])

  const captures = capturePresence(instance, phase, ['box'])
  const errors: unknown[] = []
  const session = new PresenceOperation(captures, phase, (error) => errors.push(error))

  sessions.push(session)

  return { element, instance, session, errors }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.cancel('owner-teardown')

  for (const instance of instances.splice(0)) instance.dispose()

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
      const session = new PresenceOperation(capturePresence(instance, 'leave', []), 'leave')

      sessions.push(session)
      session.initialize()

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

  it('releases a disposed empty participant when a sibling leave completes', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const added = vi.spyOn(media, 'addEventListener')
    const removed = vi.spyOn(media, 'removeEventListener')
    const instance = new LivaInstance({ name: 'external', layers: [] })
    const owner = setup('leave', { kind: 'tween', durationMs: 1000, easing: 'linear' })
    const { element, errors } = owner
    const session = new PresenceOperation(
      [
        ...capturePresence(instance, 'leave', []),
        ...capturePresence(owner.instance, 'leave', ['box']),
      ],
      'leave',
      (error) => errors.push(error),
    )

    sessions.push(session)
    session.initialize()

    try {
      session.play()
      instance.dispose()

      expect(removed).not.toHaveBeenCalled()
      expect(session.isFinished).toBe(false)

      element.getAnimations()[0].finish()

      expect(await session.finished).toBe('completed')

      owner.instance.dispose()

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
      expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    },
  )

  it.each(['enter', 'leave'] as const)('completes %s and releases effects', async (phase) => {
    const { element, session } = setup(phase)

    session.initialize()
    session.initialize()

    expect(element.style.opacity).toBe('0')

    session.play()
    session.play()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    expect(element.getAnimations()).toEqual([])

    session.initialize()
    session.play()
  })

  it.each(['superseded', 'owner-teardown'] as const)('restores styles when %s', async (reason) => {
    const { element, session, instance } = setup('enter')

    session.initialize()
    session.play()
    session.cancel(reason)

    expect(await session.finished).toBe(reason)
    expect(element.style.opacity).toBe('1')
    expect(element.getAnimations()).toEqual([])

    instance.dispose()

    expect(element.style.opacity).toBe('0.7')
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
    expect(invalid.element.style.opacity).toBe('1')
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
      const session = new PresenceOperation(
        owners.flatMap(({ instance }) => capturePresence(instance, 'enter', ['box'])),
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

  it('keeps multiple targets of one capture in the boundary until every effect completes', async () => {
    const cases = [
      { name: 'box', baseline: '1', start: '0' },
      { name: 'badge', baseline: '0.8', start: '0.2' },
    ]
    const source: Definition = {
      name: 'multiple-receivers',
      layers: [
        {
          name: 'base',
          targets: cases.map(({ name, baseline }) => ({
            name,
            properties: [{ name: 'opacity', value: { kind: 'literal', value: baseline } }],
          })),
        },
      ],
      enter: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: cases.map(({ name, start }) => ({
          name,
          properties: [
            {
              name: 'opacity',
              keyframes: [{ offset: 0, value: { kind: 'literal', value: start } }],
            },
          ],
        })),
      },
    }
    const receivers = cases.map(() => document.createElement('div'))

    for (const element of receivers) {
      document.body.append(element)
      elements.push(element)
    }

    const instance = new LivaInstance(source)
    instances.push(instance)
    instance.bind(cases.map(({ name }, index) => [name, receivers[index]] as const))
    const operation = new PresenceOperation(
      capturePresence(
        instance,
        'enter',
        cases.map(({ name }) => name),
      ),
      'enter',
    )
    sessions.push(operation)

    operation.play()

    const effects = receivers.map((element) => element.getAnimations()[0])
    effects[0].finish()

    await Promise.resolve()
    await Promise.resolve()

    expect(operation.isFinished).toBe(false)

    effects[1].finish()

    expect(await operation.finished).toBe('completed')
    expect(receivers.map((element) => element.style.opacity)).toEqual(
      cases.map(({ baseline }) => baseline),
    )
  })

  it('stops initialization writes when ownership refresh tears down the operation', async () => {
    const source: Definition = {
      name: 'startup-cancellation',
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
    const element = document.createElement('div')
    document.body.append(element)
    elements.push(element)
    const executor = new PresentationExecutor(() => {})
    const runtime = new Runtime(executor, source, {}, () => {})
    executor.attach(runtime.environment)
    executor.bind([['box', element]])
    const operation = new PresenceOperation([executor.capturePresence('enter', ['box'])], 'enter')
    const refresh = vi
      .spyOn(runtime.environment, 'refreshOwnership')
      .mockImplementationOnce(() => operation.cancel('owner-teardown'))

    try {
      operation.initialize()
      operation.play()

      expect(await operation.finished).toBe('owner-teardown')
      expect(element.style.opacity).toBe('1')
      expect(element.getAnimations()).toEqual([])
    } finally {
      refresh.mockRestore()
      runtime.dispose()
    }
  })

  it('uses the captured definition final accepted baseline after replacement', async () => {
    const source: Definition = {
      name: 'retained-baseline',
      parameters: [{ name: 'amount', type: 'number' }],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  value: { kind: 'template', parts: [{ kind: 'reference', path: ['amount'] }] },
                },
              ],
            },
          ],
        },
      ],
      leave: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [{ name: 'box', properties: [{ name: 'opacity' }] }],
      },
    }
    const instance = new LivaInstance(source, { amount: 0.5 })
    const element = document.createElement('div')
    document.body.append(element)
    elements.push(element)
    instances.push(instance)
    instance.bind([['box', element]])
    const captures = capturePresence(instance, 'leave', ['box'])

    instance.updateParameters({ amount: 0.8 })
    instance.replaceDefinition({
      ...source,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
            },
          ],
        },
      ],
    })
    const operation = new PresenceOperation(captures, 'leave')
    sessions.push(operation)
    operation.play()
    const effect = element.getAnimations()[0].effect

    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected retained leave effect')

    expect(effect.getKeyframes().at(-1)?.opacity).toBe('0.8')

    operation.cancel('owner-teardown')

    expect(await operation.finished).toBe('owner-teardown')
    expect(element.style.opacity).toBe('0.2')
  })

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
    let played = false
    const capture = createPresenceCapture(
      {
        release() {},
        initialize(owner) {
          owner.cancel('owner-teardown')
        },
        play() {
          played = true
        },
        end() {},
      },
      'enter',
    )
    const session = new PresenceOperation([capture], 'enter')

    sessions.push(session)

    session.play()

    expect(await session.finished).toBe('owner-teardown')
    expect(played).toBe(false)
  })

  it('keeps authored endpoints distinct from the application completion value', async () => {
    const { session, element, errors } = setup(
      'enter',
      { kind: 'tween', durationMs: 30, easing: 'linear' },
      { end: '0.6' },
    )

    sessions.push(session)

    session.initialize()
    session.play()
    element.getAnimations()[0].finish()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('fails detached relative playback if reference retarget observation fails', async () => {
    const { session, element, errors, instance } = setup(
      'leave',
      {
        kind: 'spring-duration',
        durationMs: 1000,
        bounce: 0.1,
      },
      {
        property: 'translate',
        start: '0px',
        end: '100%',
        baseline: '0px',
        style: 'width:100px;translate:0px;',
      },
    )

    instance.dispose()
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

  it('settles detached leave on media changes without restarting on a non-reduced notification', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const query = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const { element, session, instance } = setup('leave', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })

    instance.dispose()

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

  it('captures connected and detached presentation while skipping absent targets', async () => {
    const { element, instance } = setup('leave')
    const absent = new PresenceOperation(capturePresence(instance, 'leave', ['absent']), 'leave')

    absent.play()

    expect(await absent.finished).toBe('completed')
    expect(instance.animations).toEqual([])

    for (const connected of [true, false]) {
      if (!connected) element.remove()

      const operation = new PresenceOperation(capturePresence(instance, 'leave', ['box']), 'leave')

      sessions.push(operation)
      operation.play()

      const effect = instance.animations[0].effect

      if (!(effect instanceof KeyframeEffect)) throw new Error('Expected captured native effect')

      expect(effect.getKeyframes()[0].opacity).toBe('0')

      operation.cancel('owner-teardown')

      expect(await operation.finished).toBe('owner-teardown')
      expect(element.style.opacity).toBe('0.7')
    }
  })
})
