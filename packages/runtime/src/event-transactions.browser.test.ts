import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Definition, Expression } from './definition.ts'
import type { ReactiveSubscription, RuntimeValue } from './reactive-value.ts'
import { createEventValue, type ReactiveNotification } from './events.ts'
import { LivaInstance, type RuntimeDiagnostic } from './instance.ts'
const sourceState = vi.hoisted<{ source?: ReactiveSubscription }>(() => ({}))

vi.mock('./builtins/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./builtins/index.ts')>()

  return {
    ...original,
    callBuiltin: (name: string, args: Readonly<Record<string, RuntimeValue>>) =>
      name === 'testSource' && sourceState.source
        ? sourceState.source
        : original.callBuiltin(name, args),
  }
})

const reference = (...path: string[]): Expression => ({ kind: 'reference', path })
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
          attachment: { target: 'self', property: 'translate' },
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
                value: '0px 0px',
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
            targets: [{ name: 'self', properties: [{ name: 'translate', value: '120px 0px' }] }],
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
            properties: [{ name: 'translate', value: '', binding: reference('movement') }],
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
