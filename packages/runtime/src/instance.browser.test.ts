import { afterEach, describe, expect, it } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import fixture from '../../../fixtures/toggle.json'
import reactiveFixture from '../../../fixtures/reactive-toggle.json'
import cardFixture from '../../../fixtures/card.json'
import { decodeBundle } from './definition.ts'
import { LivaInstance, type RuntimeDiagnostic } from './instance.ts'
import { LifecycleSession } from './lifecycle.ts'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const instances: LivaInstance[] = []
const elements: HTMLElement[] = []

function setup(def = definition, state: string | Record<string, unknown> = 'off') {
  const errors: RuntimeDiagnostic[] = []
  const instance = new LivaInstance(def, state, (error) => errors.push(error))
  const targets = new Map(
    def.states[0].targets.map(({ name }) => {
      const element = document.createElement('div')

      document.body.append(element)
      elements.push(element)
      return [name, element] as const
    }),
  )

  instances.push(instance)
  instance.bind([...targets])

  return { instance, targets, errors }
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose()

  for (const element of elements.splice(0)) element.remove()
})

describe('browser animation execution', () => {
  it('interpolates a paused transition and restores owned styles on disposal', () => {
    const { instance, targets, errors } = setup()
    const thumb = targets.get('thumb')!

    expect(instance.setState('on', { paused: true })).toBe(true)
    expect(instance.animations.length).toBeGreaterThan(0)

    for (const animation of instance.animations) animation.currentTime = 100

    expect(parseFloat(getComputedStyle(thumb).scale)).toBeGreaterThan(1)
    expect(errors).toEqual([])

    instance.dispose()

    expect(instance.animations).toEqual([])
    expect(thumb.style.scale).toBe('')
    expect(instance.setState('off')).toBe(false)

    instance.bind([...targets])
    instance.replaceDefinition(definition)
    instance.updateParameters({})
  })

  it('completes animations and settles destination styles', async () => {
    const { instance, targets } = setup()

    expect(instance.setState('on')).toBe(true)

    const animations = [...instance.animations]

    await Promise.all(animations.map((animation) => animation.ready))

    for (const animation of animations) animation.finish()

    await Promise.all(animations.map((animation) => animation.finished))
    await Promise.resolve()

    expect(instance.animations).toEqual([])
    expect(targets.get('thumb')!.style.scale).toBe('1')
    expect(instance.setState('on')).toBe(true)
  })

  it('handles interruption, rebinding and invalid states without losing the current state', () => {
    const { instance, targets, errors } = setup()

    instance.setState('on', { paused: true })

    const first = instance.animations[0]

    first.currentTime = 100
    instance.setState('off', { paused: true })

    expect(first.playState).toBe('idle')
    expect(instance.setState('missing')).toBe(false)
    expect(instance.state).toBe('off')
    expect(errors.at(-1)?.code).toBe('runtime.state')

    instance.bind([...targets])

    expect(instance.animations.length).toBeGreaterThan(0)

    instance.bind([])

    expect(instance.animations).toEqual([])
    expect(errors.at(-1)?.message).toBe('Missing target binding')
    expect(instance.setState('on')).toBe(true)

    instance.bind([...targets, ['thumb', targets.get('thumb')!]])

    expect(errors.at(-1)?.message).toBe('Duplicate target binding')

    instance.bind([...targets])

    expect(targets.get('thumb')!.style.scale).toBe('1')
  })

  it('preserves external style edits and original declarations', () => {
    const { instance, targets } = setup()

    instance.dispose()

    const thumb = targets.get('thumb')!

    thumb.style.cssText = 'scale: 2 !important; color: red; margin: 4px'

    const replacement = new LivaInstance(definition, 'off')

    instances.push(replacement)
    replacement.bind([...targets])
    thumb.style.color = 'blue'
    thumb.style.removeProperty('margin')
    replacement.dispose()

    expect(thumb.style.scale).toBe('2')
    expect(thumb.style.getPropertyPriority('scale')).toBe('important')
    expect(thumb.style.color).toBe('blue')
    expect(thumb.style.margin).toBe('')
  })

  it('updates reactive parameters and retains them through definition replacement', () => {
    const reactive = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
    const { instance, errors } = setup(reactive, { checked: false })

    instance.updateParameters({ checked: true })

    expect(instance.state).toBe('on')
    expect(instance.reactiveState).toBe('on')

    instance.replaceDefinition(structuredClone(reactive))

    expect(instance.state).toBe('on')

    instance.updateParameters({ checked: 'invalid' })

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(instance.state).toBe('on')

    instance.updateParameters({ checked: false })

    expect(instance.state).toBe('off')
  })
})

it('updates template values in place and recovers from non-finite expressions', async () => {
  const templated = {
    name: 'size',
    parameters: [{ name: 'x', type: 'number' } as const],
    directionalTransitions: [],
    states: [
      {
        name: 'idle',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: '0px',
                template: [
                  {
                    kind: 'binary',
                    operator: '/',
                    left: { kind: 'number', value: 100 },
                    right: { kind: 'reference', path: ['x'] },
                  },
                  'px',
                ],
              },
            ],
          },
        ],
      },
    ],
  } satisfies import('./definition.ts').Definition
  const { instance, targets, errors } = setup(templated, { x: 0 })

  expect(errors.at(-1)?.code).toBe('runtime.expression')

  const enter = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', enter)
  instance.updateParameters({ x: 2 })

  expect(await enter.finished).toBe('superseded')
  expect(targets.get('box')!.style.width).toBe('50px')

  instance.updateParameters({ x: 2 })

  expect(targets.get('box')!.style.width).toBe('50px')

  instance.updateParameters({ x: 0 })

  expect(errors.at(-1)?.code).toBe('runtime.expression')
  expect(targets.get('box')!.style.width).toBe('50px')
})

it('restores variable shorthands and preserves external priority changes', () => {
  const def = {
    name: 'spacing',
    states: [
      {
        name: 'on',
        targets: [{ name: 'box', properties: [{ name: 'margin', value: 'var(--b)' }] }],
      },
    ],
    directionalTransitions: [],
  }
  const element = document.createElement('div')

  element.style.cssText = 'margin: var(--a); width: 12px !important; color: red'
  document.body.append(element)
  elements.push(element)

  const instance = new LivaInstance(def, 'on')

  instances.push(instance)
  instance.bind([['box', element]])
  element.style.width = '20px'
  element.style.removeProperty('color')
  instance.dispose()

  expect(element.style.margin).toBe('var(--a)')
  expect(element.style.width).toBe('20px')
  expect(element.style.getPropertyPriority('width')).toBe('')
  expect(element.style.color).toBe('')

  const second = new LivaInstance(def, 'on')

  instances.push(second)
  second.bind([['box', element]])
  element.style.setProperty('margin', 'var(--external)', 'important')
  second.dispose()

  expect(element.style.margin).toBe('var(--external)')
  expect(element.style.getPropertyPriority('margin')).toBe('important')
})

it('skips zero-duration effects and rolls back invalid browser easing', () => {
  const base = {
    name: 'fade',
    states: ['off', 'on'].map((name) => ({
      name,
      targets: [
        { name: 'box', properties: [{ name: 'opacity', value: name === 'off' ? '0' : '1' }] },
      ],
    })),
    directionalTransitions: [],
    generalTransition: {
      timing: { kind: 'tween', durationMs: 0, easing: 'linear' } as const,
      targets: [],
    },
  }
  const { instance, targets, errors } = setup(base)

  expect(instance.setState('on')).toBe(true)
  expect(instance.animations).toEqual([])
  expect(targets.get('box')!.style.opacity).toBe('1')

  instance.replaceDefinition({
    ...base,
    generalTransition: {
      timing: { kind: 'tween', durationMs: 100, easing: 'invalid-easing' },
      targets: [],
    },
  })

  expect(instance.setState('off')).toBe(false)
  expect(instance.state).toBe('on')
  expect(errors.at(-1)?.code).toBe('runtime.animation')
})

it('settles active effects when reduced motion is enabled but preserves manual previews', async () => {
  const { instance, targets } = setup()

  instance.setState('on')

  const session: CDPSession = cdp()

  try {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await new Promise(requestAnimationFrame)

    await expect.poll(() => instance.animations.length).toBe(0)
    expect(targets.get('thumb')!.style.translate).toBe('24px')

    instance.setState('off', { paused: true })

    expect(instance.animations.length).toBeGreaterThan(0)

    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })

    await new Promise(requestAnimationFrame)

    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await new Promise(requestAnimationFrame)

    expect(instance.animations.length).toBeGreaterThan(0)
  } finally {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })

    await new Promise(requestAnimationFrame)
  }
})

it('releases only matching lifecycle effects and protects leave-owned properties', async () => {
  const { instance, targets } = setup()

  instance.setState('on', { paused: true })

  const before = instance.animations.length

  instance.releaseLifecycle(['thumb'], targets.get('track')!)

  expect(instance.animations).toHaveLength(before)

  instance.releaseLifecycle(['thumb'], targets.get('thumb')!)

  expect(instance.animations.length).toBeLessThan(before)

  const session = new LifecycleSession(
    [
      {
        element: targets.get('track')!,
        track: {
          target: 'track',
          property: 'background-color',
          timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
          keyframes: [
            { offset: 0, value: 'red' },
            { offset: 1, value: 'blue' },
          ],
          destinationValue: 'blue',
        },
      },
    ],
    'leave',
  )

  instance.retainLifecycle('leave', session)
  instance.setState('off', { paused: true })

  expect(
    instance.animations.every(
      (animation) =>
        animation.effect instanceof KeyframeEffect &&
        animation.effect.target !== targets.get('track'),
    ),
  ).toBe(true)

  session.cancel('owner-teardown')

  await session.finished
})

it('restores parameter snapshots when a reactive transition cannot be prepared', () => {
  const def = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
  const broken = {
    ...def,
    generalTransition: {
      targets: [],
      timing: { kind: 'tween', durationMs: 100, easing: 'invalid' } as const,
    },
    directionalTransitions: [],
  }
  const { instance, errors } = setup(broken, { checked: false })

  instance.updateParameters({ checked: true })

  expect(errors.at(-1)?.code).toBe('runtime.animation')
  expect(instance.state).toBe('off')
  expect(instance.reactiveState).toBe('off')
})

it('stops a reactive update when an event listener disposes its owner', () => {
  const base = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
  const def = {
    ...base,
    events: [{ name: 'dismiss', when: { kind: 'reference', path: ['checked'] } as const }],
  }
  const { instance } = setup(def, { checked: false })

  instance.onEvent = () => instance.dispose()
  instance.updateParameters({ checked: true })

  expect(instance.animations).toEqual([])
  expect(instance.setState('on')).toBe(false)
})

it.each(['dispose', 'replace', 'release'] as const)(
  'ignores a queued animation completion after %s',
  async (operation) => {
    const { instance, targets } = setup()

    instance.setState('on')

    const animation = instance.animations[0]

    await animation.ready
    animation.finish()

    const finished = animation.finished

    if (operation === 'dispose') instance.dispose()
    else if (operation === 'replace') instance.replaceDefinition(definition, 'off')
    else instance.releaseLifecycle(['track'], targets.get('track')!)

    await finished

    await Promise.resolve()

    expect(instance.animations).not.toContain(animation)
    expect(targets.get('track')!.style.backgroundColor).not.toBe('rgb(52, 178, 123)')
  },
)

it('cleans drag subscriptions and reports a failed reevaluation during disposal', async () => {
  const card = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
  const def = {
    ...card,
    letBindings: [
      ...card.letBindings!,
      {
        name: 'ratio',
        initializer: {
          kind: 'binary',
          operator: '/',
          left: { kind: 'number', value: 1 },
          right: {
            kind: 'binary',
            operator: '+',
            left: { kind: 'reference', path: ['movement', 'offset', 'x'] },
            right: { kind: 'number', value: 1 },
          },
        },
      } as const,
    ],
  }
  const { instance, targets, errors } = setup(def, {})
  const body = targets.get('body')!

  body.style.cssText =
    'position:fixed;left:100px;top:20px;width:20px;height:20px;z-index:1;touch-action:none'

  const destination = document.createElement('div')

  destination.style.cssText = 'position:fixed;left:99px;top:20px;width:20px;height:20px'
  document.body.append(destination)
  elements.push(destination)
  await userEvent.dragAndDrop(body, destination, { force: true })

  expect(errors).toContainEqual(expect.objectContaining({ code: 'runtime.expression' }))

  const count = errors.length

  instance.dispose()

  expect(errors.length).toBeGreaterThan(count)
  expect(instance.animations).toEqual([])
})

it('replaces only an animated template property when its value changes within a state', () => {
  const def = {
    name: 'dynamic',
    parameters: [
      { name: 'checked', type: 'boolean' },
      { name: 'x', type: 'number' },
    ] as const,
    directionalTransitions: [],
    generalTransition: {
      timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
      targets: [],
    },
    states: [
      {
        name: 'off',
        targets: [
          {
            name: 'box',
            properties: [
              { name: 'width', value: '0px' },
              { name: 'opacity', value: '0' },
            ],
          },
          { name: 'badge', properties: [{ name: 'opacity', value: '0' }] },
        ],
      },
      {
        name: 'on',
        when: { kind: 'reference', path: ['checked'] } as const,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: '10px',
                template: [{ kind: 'reference', path: ['x'] } as const, 'px'],
              },
              { name: 'opacity', value: '1' },
            ],
          },
          { name: 'badge', properties: [{ name: 'opacity', value: '1' }] },
        ],
      },
    ],
  }
  const { instance, targets } = setup(def, { checked: false, x: 10 })

  expect(instance.captureLifecycle('enter', ['box'])).toEqual([])

  instance.updateParameters({ checked: true, x: 10 })

  expect(instance.animations).toHaveLength(3)

  instance.updateParameters({ checked: true, x: 20 })

  expect(instance.animations).toHaveLength(2)
  expect(targets.get('box')!.style.width).toBe('20px')
})

it('restores removed owned declarations but preserves external removals', () => {
  const element = document.createElement('div')

  element.style.cssText = 'width: 10px; height: 10px'
  document.body.append(element)
  elements.push(element)

  const def = {
    name: 'remove',
    states: [
      {
        name: 'off',
        targets: [
          {
            name: 'box',
            properties: [
              { name: 'width', value: '' },
              { name: 'height', value: '20px' },
            ],
          },
        ],
      },
    ],
    directionalTransitions: [],
  }
  const instance = new LivaInstance(def, 'off')

  instances.push(instance)
  instance.bind([['box', element]])

  expect(element.style.width).toBe('')

  element.style.removeProperty('height')
  instance.dispose()

  expect(element.style.width).toBe('10px')
  expect(element.style.height).toBe('')
})

it('cancels retained enters on state changes and owner disposal', async () => {
  const { instance } = setup()
  const interrupted = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', interrupted)
  instance.updateParameters({})

  expect(instance.state).toBe('on')
  expect(await interrupted.finished).toBe('superseded')

  const disposed = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', disposed)
  instance.dispose()

  expect(await disposed.finished).toBe('owner-teardown')
})

it('updates template snapshots while lifecycle targets are absent', () => {
  const def = {
    name: 'missing',
    parameters: [{ name: 'x', type: 'number' } as const],
    directionalTransitions: [],
    enter: { targets: [] },
    states: [
      {
        name: 'off',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: '0px',
                template: [{ kind: 'reference', path: ['x'] } as const, 'px'],
              },
            ],
          },
        ],
      },
    ],
  }
  const { instance, errors } = setup(def, { x: 1 })

  instance.bind([])
  instance.updateParameters({ x: 2 })

  expect(instance.state).toBe('off')
  expect(errors).toEqual([])
})

it('cancels effects prepared before a later track fails browser validation', () => {
  const broken = {
    ...definition,
    generalTransition: {
      ...definition.generalTransition!,
      targets: definition.generalTransition!.targets.map((target) => ({
        ...target,
        properties: target.properties.map((property) =>
          property.name === 'scale'
            ? {
                ...property,
                timing: { kind: 'tween', durationMs: 100, easing: 'invalid' } as const,
              }
            : property,
        ),
      })),
    },
  }
  const { instance, errors } = setup(broken)

  expect(instance.setState('on')).toBe(false)
  expect(instance.state).toBe('off')
  expect(instance.animations).toEqual([])
  expect(errors.at(-1)?.code).toBe('runtime.animation')
})
