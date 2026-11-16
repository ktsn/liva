import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Definition, Expression } from '../model/definition.ts'
import type { ReactiveSubscription, RuntimeValue } from '../evaluation/reactive-value.ts'
import { createEventValue, type ReactiveNotification } from '../evaluation/events.ts'
import { LifecycleSession } from './lifecycle.ts'
import { LivaInstance, type RuntimeDiagnostic } from './instance.ts'
import { springMotion } from '../motion/property-motion.ts'
const sourceState = vi.hoisted<{ source?: ReactiveSubscription }>(() => ({}))

vi.mock('../builtins/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../builtins/index.ts')>()

  return {
    ...original,
    callBuiltin: (name: string, args: Readonly<Record<string, RuntimeValue>>) =>
      name === 'testSource' && sourceState.source
        ? sourceState.source
        : original.callBuiltin(name, args),
  }
})

const reference = (...path: string[]): Expression => ({ kind: 'reference', path })
const withReleaseProjection: (definition: Definition) => Definition = (definition) => ({
  ...definition,
  layers: definition.layers.map((layer) => ({
    ...layer,
    transitions: layer.transitions?.map((transition, index) =>
      index === 0
        ? {
            ...transition,
            when: {
              kind: 'binary',
              operator: '>=',
              left: {
                kind: 'binary',
                operator: '+',
                left: reference('movement', 'value', 'x'),
                right: {
                  kind: 'binary',
                  operator: '*',
                  left: reference('movement', 'velocity', 'x'),
                  right: { kind: 'number', value: 200 },
                },
              },
              right: { kind: 'number', value: 80 },
            },
          }
        : transition,
    ),
  })),
})

const instances: LivaInstance[] = []
const elements: HTMLElement[] = []

function setup(transform: (definition: Definition) => Definition = (definition) => definition) {
  const release = createEventValue()
  let current: RuntimeValue = { active: false, offset: 0, release }
  let notify: ((value: RuntimeValue, notification?: ReactiveNotification) => void) | undefined
  const source: ReactiveSubscription = {
    get value() {
      return current
    },
    bind(_targets, publish) {
      notify = publish

      return () => {
        notify = undefined
      }
    },
  }
  sourceState.source = source
  const definition: Definition = {
    name: 'events',
    events: [
      {
        name: 'crossed',
        when: {
          kind: 'binary',
          operator: '>=',
          left: reference('pointer', 'offset'),
          right: { kind: 'number', value: 80 },
        },
      },
    ],
    letBindings: [
      { name: 'pointer', initializer: { kind: 'call', function: 'testSource', arguments: [] } },
      {
        name: 'movement',
        initializer: {
          kind: 'call',
          function: 'link',
          arguments: [
            { name: 'input', value: reference('pointer', 'offset') },
            { name: 'component', value: { kind: 'string', value: 'x' } },
          ],
        },
      },
    ],
    layers: [
      {
        name: 'position',
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'translate',
                value: {
                  kind: 'literal',
                  value: '0px 0px',
                },
                timing: { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
              },
            ],
          },
        ],
        initialState: 'closed',
        states: [
          { name: 'closed', targets: [] },
          {
            name: 'open',
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: 'translate',
                    value: {
                      kind: 'literal',
                      value: '120px 0px',
                    },
                  },
                ],
              },
            ],
          },
          { name: 'next', targets: [] },
        ],
        transitions: [
          {
            from: 'closed',
            to: 'open',
            event: reference('pointer', 'release'),
            when: {
              kind: 'binary',
              operator: '>=',
              left: reference('movement', 'value', 'x'),
              right: { kind: 'number', value: 80 },
            },
            transition: { targets: [] },
          },
          {
            from: 'open',
            to: 'next',
            event: reference('pointer', 'release'),
            when: { kind: 'boolean', value: true },
            transition: { targets: [] },
          },
        ],
      },
      {
        name: 'dragging',
        when: reference('pointer', 'active'),
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'translate',
                value: {
                  kind: 'binding',
                  expression: reference('movement'),
                },
              },
            ],
          },
        ],
      },
    ],
  }
  const element = document.createElement('div')
  element.style.cssText = 'width:100px;height:50px;translate:0px 0px;'
  document.body.append(element)
  elements.push(element)
  const errors: RuntimeDiagnostic[] = []
  const instance = new LivaInstance(transform(definition), {}, (error) => errors.push(error))
  instances.push(instance)
  instance.bind([['self', element]])

  function update(active: boolean, offset: number, event = false) {
    current = Object.freeze({ active, offset, release })
    notify?.(current, {
      time: performance.now(),
      snapshots: new Map([[source, current]]),
      event: event ? release : undefined,
    })
  }

  return { instance, element, errors, update }
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose()
  for (const element of elements.splice(0)) element.remove()
  sourceState.source = undefined
})

describe('event snapshot transactions', () => {
  it('keeps the accepted composition visible to source events when preview ends', () => {
    const { instance, errors, update } = setup()
    const before = instance.composition
    const seen: boolean[] = []

    instance.previewComposition(before, before)
    instance.onEvent = () => seen.push(instance.composition.layers.dragging)
    update(true, 90)

    expect(seen).toEqual([false])
    expect(instance.composition.layers.dragging).toBe(true)
    expect(errors).toEqual([])
  })

  it('rejects invalid source presentation inside the transaction when preview ends', () => {
    const { instance, errors, update } = setup((definition) => ({
      ...definition,
      layers: definition.layers.map((layer, index) =>
        index === 0
          ? {
              ...layer,
              targets: layer.targets.map((target) => ({
                ...target,
                properties: [
                  ...target.properties,
                  {
                    name: '--checked',
                    value: {
                      kind: 'template',
                      parts: [
                        {
                          kind: 'binary',
                          operator: '/',
                          left: { kind: 'number', value: 1 },
                          right: {
                            kind: 'binary',
                            operator: '-',
                            left: { kind: 'number', value: 100 },
                            right: reference('pointer', 'offset'),
                          },
                        },
                      ],
                    },
                  },
                ],
              })),
            }
          : layer,
      ),
    }))
    const before = instance.composition
    const events: string[] = []

    instance.previewComposition(before, before)
    instance.onEvent = (event) => events.push(event)

    expect(() => update(true, 100)).not.toThrow()
    expect(instance.composition).toEqual(before)
    expect(events).toEqual([])
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'runtime.expression',
        message: 'Error: Expression result must be finite',
      }),
    ])

    update(true, 90)

    expect(events).toEqual(['crossed'])
    expect(instance.composition.layers.dragging).toBe(true)
  })

  it('preserves the first controller input delta when a source notification ends preview', () => {
    const { instance, element, errors, update } = setup()

    update(true, 0)
    update(true, 20)
    instance.previewComposition(instance.composition, instance.composition)
    update(true, 30)

    expect(getComputedStyle(element).translate).toBe('30px')
    expect(errors).toEqual([])
  })

  it('rejects invalid active presence before accepting source calls, events, or state history', async () => {
    const { instance, element, errors, update } = setup((definition) => ({
      ...definition,
      layers: definition.layers.map((layer, index) =>
        index === 0
          ? {
              ...layer,
              targets: layer.targets.map((target) => ({
                ...target,
                properties: [
                  ...target.properties,
                  { name: 'color', value: { kind: 'literal', value: 'red' } },
                ],
              })),
            }
          : layer,
      ),
      enter: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'color',
                keyframes: [
                  {
                    offset: 0,
                    value: {
                      kind: 'template',
                      parts: [
                        'rgb(',
                        {
                          kind: 'binary',
                          operator: '/',
                          left: { kind: 'number', value: 1 },
                          right: {
                            kind: 'binary',
                            operator: '-',
                            left: { kind: 'number', value: 100 },
                            right: reference('pointer', 'offset'),
                          },
                        },
                        ', 0, 0)',
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    }))

    update(true, 0)

    const session = new LifecycleSession(instance.captureLifecycle('enter', ['self']), 'enter')

    session.initialize()
    session.play()

    const original = element.getAnimations()[0]

    original.pause()
    original.currentTime = 0

    const events: string[] = []

    instance.onEvent = (event) => events.push(`${event}:${instance.composition.states.position}`)

    try {
      update(false, 100, true)

      expect(instance.composition.states.position).toBe('closed')
      expect(events).toEqual([])
      expect(element.getAnimations()).toContain(original)
      expect(errors).toEqual([
        expect.objectContaining({
          code: 'runtime.expression',
          message: 'Error: Expression result must be finite',
        }),
      ])

      update(false, 90, true)

      expect(instance.composition.states.position).toBe('open')
      expect(events).toEqual(['crossed:closed'])
      expect(session.isFinished).toBe(false)

      for (const animation of element.getAnimations()) animation.finish()

      expect(await session.finished).toBe('completed')
    } finally {
      session.cancel('owner-teardown')
    }
  })

  it('keeps newer synchronous occurrences behind already deferred occurrences', async () => {
    const { instance, update, errors } = setup((definition) => {
      const position = definition.layers[0]

      if (!position.states || !position.transitions) throw new Error('Expected a stateful layer')

      return {
        ...definition,
        layers: [
          {
            ...position,
            states: [...position.states, { name: 'other', targets: [] }],
            transitions: [
              position.transitions[0],
              {
                ...position.transitions[1],
                when: {
                  kind: 'binary',
                  operator: '==',
                  left: reference('pointer', 'offset'),
                  right: { kind: 'number', value: 0 },
                },
              },
              {
                ...position.transitions[1],
                to: 'other',
                when: {
                  kind: 'binary',
                  operator: '>=',
                  left: reference('pointer', 'offset'),
                  right: { kind: 'number', value: 80 },
                },
              },
            ],
          },
          ...definition.layers.slice(1),
        ],
      }
    })
    instance.onEvent = () => update(false, 0, true)
    update(true, 0)

    update(false, 100, true)
    update(false, 100, true)

    expect(instance.composition.states.position).toBe('open')

    await Promise.resolve()
    await Promise.resolve()

    expect(instance.composition.states.position).toBe('next')
    expect(errors).toEqual([])
  })

  it('discards occurrences queued before a later synchronous disposal', async () => {
    const { instance, element, update, errors } = setup()
    instance.onEvent = () => update(false, 0, true)
    update(true, 0)
    update(false, 100, true)

    expect(instance.composition.states.position).toBe('open')
    instance.dispose()
    await Promise.resolve()
    await Promise.resolve()

    expect(instance.composition.states.position).toBe('open')
    expect(element.getAnimations()).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it.each(['deliver', 'replace', 'dispose'] as const)(
    'queues reentrant occurrences separately and drops obsolete sessions: %s',
    async (mode) => {
      const { instance, element, update, errors } = setup()
      let calls = 0
      const during: string[] = []
      instance.onEvent = () => {
        calls++
        update(false, 0, true)
        update(false, 0, true)
        instance.updateParameters({})

        during.push(instance.composition.states.position)

        if (mode === 'replace') instance.bind([])
        if (mode === 'dispose') instance.dispose()
      }
      update(true, 0)

      update(false, 100, true)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(calls).toBe(1)
      expect(during).toEqual(['closed'])
      expect(instance.composition.states.position).toBe(mode === 'deliver' ? 'next' : 'closed')
      expect(element.getAnimations()).toHaveLength(mode === 'deliver' ? 1 : 0)
      expect(errors).toEqual([])
    },
  )

  it('uses final input before release guards and processes one transition per occurrence', async () => {
    const { instance, element, errors, update } = setup()
    update(true, 0)
    update(true, 50)

    update(false, 100, true)

    expect(instance.composition.states.position).toBe('open')
    const animation = instance.animations[0]
    if (!(animation?.effect instanceof KeyframeEffect)) throw new Error('Expected return spring')
    expect(String(animation.effect.getKeyframes()[0].translate)).toMatch(/^100px(?: |$)/)

    animation.finish()
    await animation.finished
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(instance.composition.states.position).toBe('open')
    expect(parseFloat(getComputedStyle(element).translate)).toBe(120)

    update(true, 0)
    update(false, 0, true)

    expect(instance.composition.states.position).toBe('next')
    expect(errors).toEqual([])
  })

  it.each([
    { name: 'fast flick', moves: [[110, 20]], time: 120, input: 20, state: 'open' },
    { name: 'stationary hold', moves: [[110, 20]], time: 200, input: 20, state: 'closed' },
    { name: 'terminal displacement', moves: [[110, 20]], time: 120, input: 70, state: 'open' },
    {
      name: 'direction reversal',
      moves: [
        [110, 20],
        [120, 15],
      ],
      time: 130,
      input: 15,
      state: 'closed',
    },
    { name: 'same-time movement', moves: [[100, 20]], time: 100, input: 20, state: 'closed' },
  ])('routes release using input history for $name without frame samples', (sample) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { instance, errors, update } = setup(withReleaseProjection)
    update(true, 0)

    for (const [time, input] of sample.moves) {
      clock.mockReturnValue(time)
      update(true, input)
    }

    clock.mockReturnValue(sample.time)
    update(false, sample.input, true)

    expect(instance.composition.states.position).toBe(sample.state)
    expect(errors).toEqual([])

    clock.mockRestore()
  })

  it('starts the release spring with the input derivative without any frame samples', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { instance, element, errors, update } = setup(withReleaseProjection)
    update(true, 0)
    clock.mockReturnValue(110)
    update(true, 20)
    clock.mockReturnValue(120)

    update(false, 20, true)
    const animation = instance.animations[0]
    if (!(animation?.effect instanceof KeyframeEffect)) throw new Error('Expected momentum spring')
    const expected = springMotion(
      { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
      [20],
      [120],
      [2],
    )
    // Sample at an authored frame boundary, excluding WAAPI's linear approximation
    // between frames from the assertion about the inherited initial velocity.
    const sampleTime = animation.effect.getKeyframes()[1].computedOffset * expected.durationMs

    animation.pause()
    animation.currentTime = sampleTime

    expect(parseFloat(getComputedStyle(element).translate)).toBeCloseTo(
      expected.sample(sampleTime).value[0],
      3,
    )
    expect(errors).toEqual([])

    clock.mockRestore()
  })

  it.each([
    { name: 'half', input: -10, releaseTime: 120, state: 'half' },
    { name: 'expanded', input: -20, releaseTime: 120, state: 'expanded' },
    { name: 'held near closed', input: -10, releaseTime: 200, state: 'closed' },
  ])('routes a vertical bottom sheet to $state for $name', (sample) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { instance, errors, update } = setup((definition) => {
      const projected: Expression = {
        kind: 'binary',
        operator: '+',
        left: reference('movement', 'value', 'y'),
        right: {
          kind: 'binary',
          operator: '*',
          left: reference('movement', 'velocity', 'y'),
          right: { kind: 'number', value: 200 },
        },
      }
      const below = (value: number): Expression => ({
        kind: 'binary',
        operator: '<',
        left: projected,
        right: { kind: 'number', value },
      })
      const atLeast = (value: number): Expression => ({
        kind: 'binary',
        operator: '>=',
        left: projected,
        right: { kind: 'number', value },
      })
      const destinations = [
        { to: 'expanded', when: below(100) },
        {
          to: 'half',
          when: {
            kind: 'binary',
            operator: '&&',
            left: atLeast(100),
            right: below(300),
          } as Expression,
        },
        { to: 'closed', when: atLeast(300) },
      ]

      return {
        ...definition,
        letBindings: definition.letBindings?.map((binding) => ({
          ...binding,
          initializer:
            binding.name === 'movement'
              ? {
                  kind: 'call',
                  function: 'link',
                  arguments: [
                    { name: 'input', value: reference('pointer', 'offset') },
                    { name: 'component', value: { kind: 'string', value: 'y' } },
                  ],
                }
              : binding.initializer,
        })),
        layers: definition.layers.map((layer) =>
          layer.name !== 'position'
            ? layer
            : {
                ...layer,
                targets: [
                  {
                    name: 'self',
                    properties: [
                      {
                        name: 'translate',
                        value: {
                          kind: 'literal',
                          value: '0px 400px',
                        },
                        timing: { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
                      },
                    ],
                  },
                ],
                states: [
                  { name: 'closed', targets: [] },
                  {
                    name: 'half',
                    targets: [
                      {
                        name: 'self',
                        properties: [
                          {
                            name: 'translate',
                            value: {
                              kind: 'literal',
                              value: '0px 200px',
                            },
                          },
                        ],
                      },
                    ],
                  },
                  {
                    name: 'expanded',
                    targets: [
                      {
                        name: 'self',
                        properties: [
                          {
                            name: 'translate',
                            value: {
                              kind: 'literal',
                              value: '0px 0px',
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
                transitions: ['closed', 'half', 'expanded'].flatMap((from) =>
                  destinations.map((destination) => ({
                    from,
                    ...destination,
                    event: reference('pointer', 'release'),
                    transition: { targets: [] },
                  })),
                ),
              },
        ),
      }
    })
    update(true, 0)
    clock.mockReturnValue(110)
    update(true, sample.input)
    clock.mockReturnValue(sample.releaseTime)

    update(false, sample.input, true)

    expect(instance.composition.states.position).toBe(sample.state)
    expect(errors).toEqual([])

    clock.mockRestore()
  })

  it('never retries an occurrence that matched no guard on later property updates', async () => {
    const { instance, update, errors } = setup()
    update(true, 0)
    update(true, 20)

    update(false, 20, true)

    expect(instance.composition.states.position).toBe('closed')

    update(false, 200)
    await Promise.resolve()

    expect(instance.composition.states.position).toBe('closed')
    expect(errors).toEqual([])
  })
})
