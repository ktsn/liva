import type { Definition as PropertyIRDefinition } from './definition.ts'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import selfFixture from '../../../fixtures/self-target.json'
import fixture from '../../../fixtures/toggle.json'
import reactiveFixture from '../../../fixtures/reactive-toggle.json'
import cardFixture from '../../../fixtures/card.json'
import { layerTargets } from './layers.ts'
import { decodeBundle } from './definition.ts'
import { LivaInstance, type RuntimeDiagnostic } from './instance.ts'
import { LifecycleSession } from './lifecycle.ts'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const instances: LivaInstance[] = []
const elements: HTMLElement[] = []

function setup(
  def = definition,
  inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
    ? { mode: 'off' }
    : {},
) {
  const errors: RuntimeDiagnostic[] = []
  const instance = new LivaInstance(def, inputs, (error) => errors.push(error))
  const targets = new Map(
    layerTargets(def).map(({ name }) => {
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

function updateMode(instance: LivaInstance, mode: string, options: { paused?: boolean } = {}) {
  instance.updateParameters({ mode })

  if (options.paused) {
    for (const animation of instance.animations) animation.pause()
  }
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose()

  for (const element of elements.splice(0)) element.remove()
})

describe('browser animation execution', () => {
  it('plays compiled explicit self properties on the root with their shared timing', async () => {
    const source = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { instance, targets, errors } = setup(source, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    instance.updateParameters({ active: true })
    const animation = instance.animations[0]

    expect(instance.animations).toHaveLength(1)
    expect(animation.effect?.getTiming().duration).toBe(150)

    animation.pause()
    animation.currentTime = 75

    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(1)
    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('scrubs compiled self lifecycle timing without leaking to shorthand endpoints', () => {
    const source = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { instance, targets } = setup(source, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    instance.previewLifecycle('enter', { layers: { base: true, interaction: false }, states: {} })

    for (const animation of instance.animations) animation.currentTime = 100

    // Default tween easing is ease, so use actual effect timings rather than assume linear interpolation.
    expect(
      instance.animations
        .map((animation) => Number(animation.effect?.getTiming().duration))
        .toSorted((a, b) => a - b),
    ).toEqual([200, 400])
    expect(Number(getComputedStyle(root!).opacity)).toBeGreaterThan(0)
    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(0.8)

    instance.endCompositionPreview()

    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(getComputedStyle(root!).scale).toBe('1')
  })

  it('keeps missing bindings suspended across definition replacement and empty input updates', () => {
    const source = {
      name: 'static',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies PropertyIRDefinition
    const { instance, targets } = setup(source)

    instance.bind([])
    instance.replaceDefinition(source)
    instance.updateParameters({})

    expect(instance.animations).toHaveLength(0)
    expect(targets.get('body')!.style.opacity).toBe('')

    instance.bind([...targets])

    expect(targets.get('body')!.style.opacity).toBe('1')
  })

  it('interpolates a paused transition and restores owned styles on disposal', () => {
    const { instance, targets, errors } = setup()
    const thumb = targets.get('thumb')!

    updateMode(instance, 'on', { paused: true })
    expect(instance.animations.length).toBeGreaterThan(0)

    for (const animation of instance.animations) animation.currentTime = 100

    expect(parseFloat(getComputedStyle(thumb).scale)).toBeGreaterThan(1)
    expect(errors).toEqual([])

    instance.dispose()

    expect(instance.animations).toEqual([])
    expect(thumb.style.scale).toBe('')
    updateMode(instance, 'off')

    instance.bind([...targets])
    instance.replaceDefinition(definition)
    instance.updateParameters({ mode: 'on' })
  })

  it('completes animations and settles destination styles', async () => {
    const { instance, targets } = setup()

    updateMode(instance, 'on')

    const animations = [...instance.animations]

    await Promise.all(animations.map((animation) => animation.ready))

    for (const animation of animations) animation.finish()

    await Promise.all(animations.map((animation) => animation.finished))
    await Promise.resolve()

    expect(instance.animations).toEqual([])
    expect(targets.get('thumb')!.style.scale).toBe('1')
    updateMode(instance, 'on')
  })

  it('handles interruption, rebinding and invalid parameters without losing the composition', () => {
    const { instance, targets, errors } = setup()

    updateMode(instance, 'on', { paused: true })

    const first = instance.animations[0]

    first.currentTime = 100
    updateMode(instance, 'off', { paused: true })

    expect(first.playState).toBe('idle')
    instance.updateParameters({ mode: false })
    expect(instance.composition.states.toggle).toBe('off')
    expect(errors.at(-1)?.code).toBe('runtime.parameter')

    instance.bind([...targets])

    expect(instance.animations.length).toBeGreaterThan(0)

    instance.bind([])

    expect(instance.animations).toEqual([])
    expect(errors.at(-1)?.message).toBe('Missing target binding')
    updateMode(instance, 'on')

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

    const replacement = new LivaInstance(definition, { mode: 'off' })

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

    expect(instance.composition.states.toggle).toBe('on')

    instance.replaceDefinition(structuredClone(reactive))

    expect(instance.composition.states.toggle).toBe('on')

    instance.updateParameters({ checked: 'invalid' })

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(instance.composition.states.toggle).toBe('on')

    instance.updateParameters({ checked: false })

    expect(instance.composition.states.toggle).toBe('off')
  })
})

it('updates template values in place and recovers from non-finite expressions', async () => {
  const templated = {
    name: 'size',
    parameters: [{ name: 'x', type: 'number' } as const],

    layers: [
      {
        name: 'idle',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'template',
                  parts: [
                    {
                      kind: 'binary',
                      operator: '/',
                      left: { kind: 'number', value: 100 },
                      right: { kind: 'reference', path: ['x'] },
                    },
                    'px',
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies import('./definition.ts').Definition
  const { instance, targets, errors } = setup(templated, { x: 1 })

  instance.updateParameters({ x: 0 })

  expect(errors.at(-1)?.code).toBe('runtime.expression')

  const enter = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', enter)
  instance.updateParameters({ x: 2 })

  expect(enter.isFinished).toBe(false)

  enter.play()

  expect(await enter.finished).toBe('completed')
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
    layers: [
      {
        name: 'on',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'margin',
                value: {
                  kind: 'literal',
                  value: 'var(--b)',
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies PropertyIRDefinition
  const element = document.createElement('div')

  element.style.cssText = 'margin: var(--a); width: 12px !important; color: red'
  document.body.append(element)
  elements.push(element)

  const instance = new LivaInstance(def)

  instances.push(instance)
  instance.bind([['box', element]])
  element.style.width = '20px'
  element.style.removeProperty('color')
  instance.dispose()

  expect(element.style.margin).toBe('var(--a)')
  expect(element.style.width).toBe('20px')
  expect(element.style.getPropertyPriority('width')).toBe('')
  expect(element.style.color).toBe('')

  const second = new LivaInstance(def)

  instances.push(second)
  second.bind([['box', element]])
  element.style.setProperty('margin', 'var(--external)', 'important')
  second.dispose()

  expect(element.style.margin).toBe('var(--external)')
  expect(element.style.getPropertyPriority('margin')).toBe('important')
})

it('skips zero-duration layer effects', () => {
  const base = {
    name: 'fade',
    parameters: [{ name: 'mode', type: 'string' as const }],
    layers: ['off', 'on'].map((name) => ({
      name,
      when: {
        kind: 'binary' as const,
        operator: '==',
        left: { kind: 'reference' as const, path: ['mode'] },
        right: { kind: 'string' as const, value: name },
      },
      timing: { kind: 'tween' as const, durationMs: 0, easing: 'linear' },
      targets: [
        {
          name: 'box',
          properties: [
            {
              name: 'opacity',
              value: { kind: 'literal', value: name === 'off' ? '0' : '1' },
            },
          ],
        },
      ],
    })),
  } satisfies PropertyIRDefinition
  const { instance, targets } = setup(base)

  updateMode(instance, 'on')

  expect(instance.animations).toEqual([])
  expect(targets.get('box')!.style.opacity).toBe('1')
})

it('settles active effects when reduced motion is enabled but preserves manual previews', async () => {
  const { instance, targets } = setup()

  updateMode(instance, 'on')

  const session: CDPSession = cdp()

  try {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await new Promise(requestAnimationFrame)

    await expect.poll(() => instance.animations.length).toBe(0)
    expect(targets.get('thumb')!.style.translate).toBe('24px')

    instance.previewComposition(
      { layers: {}, states: { toggle: 'on' } },
      { layers: {}, states: { toggle: 'off' } },
      [{ layer: 'toggle', index: 1 }],
    )

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

  updateMode(instance, 'on', { paused: true })

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
  updateMode(instance, 'off', { paused: true })

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
    layers: def.layers.map((layer) => ({
      ...layer,
      transitions: layer.transitions?.map((transition) => ({
        ...transition,
        transition: {
          targets: [],
          timing: { kind: 'tween' as const, durationMs: 100, easing: 'invalid' },
        },
      })),
    })),
  }
  const { instance, errors } = setup(broken, { checked: false })

  instance.updateParameters({ checked: true })

  expect(errors.at(-1)?.code).toBe('runtime.expression')
  expect(instance.composition.states.toggle).toBe('off')
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
  updateMode(instance, 'on')
})

it.each(['dispose', 'replace', 'release'] as const)(
  'ignores a queued animation completion after %s',
  async (operation) => {
    const { instance, targets } = setup()

    updateMode(instance, 'on')

    const animation = instance.animations[0]

    await animation.ready
    animation.finish()

    const finished = animation.finished

    if (operation === 'dispose') instance.dispose()
    else if (operation === 'replace') instance.replaceDefinition(definition)
    else instance.releaseLifecycle(['track'], targets.get('track')!)

    targets.get('track')!.style.backgroundColor = 'blue'

    await finished

    await Promise.resolve()

    expect(instance.animations).not.toContain(animation)
    expect(targets.get('track')!.style.backgroundColor).toBe('blue')
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
    layers: [
      {
        name: 'off',
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'literal',
                  value: '0px',
                },
              },
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '0',
                },
              },
            ],
          },
          {
            name: 'badge',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '0',
                },
              },
            ],
          },
        ],
      },
      {
        name: 'on',
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
        when: { kind: 'reference', path: ['checked'] } as const,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'template',
                  parts: [{ kind: 'reference', path: ['x'] } as const, 'px'],
                },
              },
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
            ],
          },
          {
            name: 'badge',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies PropertyIRDefinition
  const { instance, targets } = setup(def, { checked: false, x: 10 })

  expect(instance.captureLifecycle('enter', ['box'])).toEqual([])

  instance.updateParameters({ checked: true, x: 10 })

  expect(instance.animations).toHaveLength(3)

  const previous = [...instance.animations]

  instance.updateParameters({ checked: true, x: 20 })

  expect(instance.animations).toHaveLength(3)
  expect(previous.filter((animation) => instance.animations.includes(animation))).toHaveLength(2)
  expect(targets.get('box')!.style.width).toBe('20px')
})

it('restores removed owned declarations but preserves external removals', () => {
  const element = document.createElement('div')

  element.style.cssText = 'width: 10px; height: 10px'
  document.body.append(element)
  elements.push(element)

  const def = {
    name: 'remove',
    layers: [
      {
        name: 'off',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'literal',
                  value: '',
                },
              },
              {
                name: 'height',
                value: {
                  kind: 'literal',
                  value: '20px',
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies PropertyIRDefinition
  const instance = new LivaInstance(def)

  instances.push(instance)
  instance.bind([['box', element]])

  expect(element.style.width).toBe('')

  element.style.removeProperty('height')
  instance.dispose()

  expect(element.style.width).toBe('10px')
  expect(element.style.height).toBe('')
})

it('retains enter snapshots on input changes and cancels them on owner disposal', async () => {
  const { instance } = setup()
  const interrupted = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', interrupted)
  instance.updateParameters({ mode: 'on' })

  expect(instance.composition.states.toggle).toBe('on')
  expect(interrupted.isFinished).toBe(false)

  interrupted.play()

  expect(await interrupted.finished).toBe('completed')

  const disposed = new LifecycleSession([], 'enter')

  instance.retainLifecycle('enter', disposed)
  instance.dispose()

  expect(await disposed.finished).toBe('owner-teardown')
})

it('updates template snapshots while lifecycle targets are absent', () => {
  const def = {
    name: 'missing',
    parameters: [{ name: 'x', type: 'number' } as const],
    enter: { targets: [] },
    layers: [
      {
        name: 'off',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'template',
                  parts: [{ kind: 'reference', path: ['x'] } as const, 'px'],
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies PropertyIRDefinition
  const { instance, errors } = setup(def, { x: 1 })

  instance.bind([])
  instance.updateParameters({ x: 2 })

  expect(instance.composition.layers.off).toBe(true)
  expect(errors).toEqual([])
})

it('cancels effects prepared before a later track fails browser validation', () => {
  const broken = {
    ...definition,
    layers: definition.layers.map((layer) => ({
      ...layer,
      transitions: layer.transitions?.map((transition) => ({
        ...transition,
        transition: {
          ...transition.transition,
          targets: transition.transition.targets.map((target) => ({
            ...target,
            properties: target.properties.map((property) =>
              property.name === 'scale'
                ? {
                    ...property,
                    timing: { kind: 'tween' as const, durationMs: 100, easing: 'invalid' },
                  }
                : property,
            ),
          })),
        },
      })),
    })),
  }
  const { instance, errors } = setup(broken)

  updateMode(instance, 'on')
  expect(instance.composition.states.toggle).toBe('off')
  expect(instance.animations).toEqual([])
  expect(errors.at(-1)?.code).toBe('runtime.expression')
})

it.each(['enter', 'leave'] as const)(
  'scrubs %s templates on repeated targets and restores the application composition',
  (phase) => {
    const def = {
      name: 'panel',
      parameters: [{ name: 'opacity', type: 'number' as const }],
      layers: [
        {
          name: 'idle',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
          ],
        },
      ],
      [phase]: {
        timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  {
                    offset: phase === 'enter' ? 0 : 1,
                    value: {
                      kind: 'template' as const,
                      parts: [{ kind: 'reference' as const, path: ['opacity'] }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    } satisfies PropertyIRDefinition
    const { instance, targets, errors } = setup(def, { opacity: 0.2 })
    const second = document.createElement('div')
    document.body.append(second)
    elements.push(second)
    instance.bind([
      ['body', targets.get('body')!],
      ['body', second],
    ])

    instance.previewLifecycle(phase)
    expect(instance.animations).toHaveLength(2)

    for (const animation of instance.animations) animation.currentTime = 100

    for (const element of [targets.get('body')!, second]) {
      expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(0.6)
      expect(element.isConnected).toBe(true)
    }

    instance.replaceDefinition(def)

    expect(instance.animations).toHaveLength(0)
    expect(getComputedStyle(second).opacity).toBe('1')
    expect(errors).toEqual([])

    instance.dispose()
    expect(() => instance.previewLifecycle(phase)).toThrow('mounted')
  },
)

it('keeps lifecycle preview preparation atomic on invalid easing and supports spring scrubbing', () => {
  const def = {
    name: 'panel',
    layers: [
      {
        name: 'off',
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
              {
                name: 'scale',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
            ],
          },
        ],
      },
    ],
    leave: {
      timing: { kind: 'spring-duration' as const, durationMs: 200, bounce: 0.2 },
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'opacity',
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
            {
              name: 'scale',
              timing: { kind: 'tween' as const, durationMs: 200, easing: 'invalid' },
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '0.5',
                  },
                  easing: 'invalid',
                },
              ],
            },
          ],
        },
      ],
    },
  } satisfies PropertyIRDefinition
  const { instance, targets, errors } = setup(def)

  expect(() => instance.previewLifecycle('leave')).toThrow('Could not prepare composition preview')
  expect(targets.get('body')!.getAnimations()).toHaveLength(0)
  expect(errors.at(-1)?.code).toBe('runtime.preview')

  const valid = {
    ...def,
    leave: {
      ...def.leave,
      targets: [{ name: 'body', properties: [def.leave.targets[0].properties[0]] }],
    },
  }
  instance.replaceDefinition(valid)

  instance.previewLifecycle('leave')
  expect(instance.animations).toHaveLength(1)
})
