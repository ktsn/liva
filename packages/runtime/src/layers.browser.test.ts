import { LifecycleSession } from './lifecycle.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import { LivaInstance, type RuntimeDiagnostic } from './instance.ts'
import { decodeBundle, type Definition, type Expression } from './definition.ts'

const ref = (name: string): Expression => ({ kind: 'reference', path: [name] })
const definition: Definition = {
  name: 'button',
  states: [],
  directionalTransitions: [],
  parameters: [
    { name: 'hover', type: 'boolean' },
    { name: 'press', type: 'boolean' },
    { name: 'size', type: 'number' },
  ],
  layers: [
    { name: 'base', targets: [{ name: 'body', properties: [{ name: 'scale', value: '1' }] }] },
    {
      name: 'hover',
      when: ref('hover'),
      targets: [
        { name: 'body', properties: [{ name: 'scale', value: '', template: [ref('size')] }] },
      ],
    },
    {
      name: 'press',
      when: ref('press'),
      targets: [
        {
          name: 'body',
          properties: [
            { name: 'scale', value: '.9' },
            { name: 'opacity', value: '.5' },
          ],
        },
      ],
    },
  ],
}
const timing = (duration: number): Expression => ({
  kind: 'call',
  function: 'tween',
  arguments: [{ name: 'duration', value: { kind: 'number', value: duration } }],
})

function timedDefinition(duration = 300): Definition {
  const timingExpression: Expression = {
    kind: 'call',
    function: 'tween',
    arguments: [{ name: 'duration', value: { kind: 'number', value: duration } }],
  }

  return {
    ...definition,
    layers: definition.layers?.map((layer) =>
      layer.name === 'base'
        ? {
            ...layer,
            targets: [
              { name: 'body', properties: [{ name: 'scale', value: '1', timingExpression }] },
            ],
          }
        : layer,
    ),
  }
}

const cleanup: (() => void)[] = []

function setup(source = definition, inputs = { hover: false, press: false, size: 1.1 }) {
  const errors: RuntimeDiagnostic[] = []
  const element = document.createElement('div')
  element.style.color = 'red'
  document.body.append(element)
  const decoded = decodeBundle(JSON.stringify({ schemaVersion: 1, definitions: [source] }))
    .definitions[0]
  const instance = new LivaInstance(decoded, inputs, (error) => errors.push(error))
  instance.bind([['body', element]])
  cleanup.push(() => {
    instance.dispose()
    element.remove()
  })

  return { instance, element, errors }
}

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

describe('reactive layer instances', () => {
  it('resolves overlap and interpolation updates while preserving unrelated styles', () => {
    const { instance, element, errors } = setup()

    instance.updateParameters({ hover: true, press: true, size: 1.2 })

    expect(element.style.scale).toBe('0.9')
    expect(element.style.opacity).toBe('0.5')

    instance.updateParameters({ hover: true, press: false, size: 1.3 })

    expect(element.style.scale).toBe('1.3')
    expect(element.style.opacity).toBe('')
    expect(element.style.color).toBe('red')
    expect(errors).toEqual([])
  })

  it('does not collide between instances with the same target names', () => {
    const first = setup()
    const second = setup()

    first.instance.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(first.element.style.scale).toBe('1.4')
    expect(second.element.style.scale).toBe('1')
  })

  it('rejects manual state selection and exposes the reactive presentation state', () => {
    const { instance, errors } = setup()

    expect(instance.setState('idle')).toBe(false)
    expect(instance.reactiveState).toBe(instance.state)
    expect(errors[0].message).toContain('reactive inputs')
  })

  it('replaces layer definitions using current parameter values', () => {
    const { instance, element } = setup(definition, { hover: true, press: false, size: 1.4 })

    instance.replaceDefinition({ ...definition, layers: definition.layers?.slice(0, 1) })

    expect(element.style.scale).toBe('1')
  })

  it('accepts updates before targets are bound without writing to other elements', () => {
    const { instance, element, errors } = setup()
    instance.bind([])

    instance.updateParameters({ hover: true, press: false, size: 1.5 })

    expect(element.style.scale).toBe('')

    instance.bind([['body', element]])
    instance.updateParameters({ hover: true, press: false, size: 1.5 })

    expect(element.style.scale).toBe('1.5')
    expect(errors[0].code).toBe('runtime.targets')
  })

  it('keeps reactive updates ready while a lifecycle target is absent', () => {
    const { instance, element, errors } = setup({ ...timedDefinition(), enter: { targets: [] } })
    instance.bind([])

    instance.updateParameters({ hover: true, press: false, size: 1.6 })
    instance.bind([['body', element]])

    expect(element.style.scale).toBe('1.6')
    expect(errors).toEqual([])
  })

  it('recomputes reactive styles after rebinding an active drag', async () => {
    const source: Definition = {
      ...definition,
      letBindings: [
        {
          name: 'dragging',
          initializer: {
            kind: 'call',
            function: 'drag',
            arguments: [{ name: 'target', value: ref('body') }],
          },
        },
      ],
      layers: [
        {
          name: 'base',
          targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
        },
        {
          name: 'drag',
          when: { kind: 'reference', path: ['dragging', 'active'] },
          targets: [{ name: 'body', properties: [{ name: 'opacity', value: '.5' }] }],
        },
      ],
    }
    const { instance, element } = setup(source)
    const replacement = document.createElement('div')
    element.style.cssText +=
      ';position:fixed;left:20px;top:20px;width:40px;height:40px;touch-action:none'
    replacement.style.cssText = 'position:fixed;left:120px;top:80px;width:40px;height:40px'
    document.body.append(replacement)
    cleanup.push(() => replacement.remove())
    let rebound = false
    instance.onReactiveState = () => {
      if (!rebound && element.style.opacity === '0.5') {
        rebound = true
        instance.bind([['body', replacement]])
      }
    }

    await userEvent.dragAndDrop(element, replacement)

    expect(rebound).toBe(true)
    expect(replacement.style.opacity).toBe('1')
  })

  it('retargets an interrupted property from its displayed presentation', async () => {
    const timingExpression: Expression = {
      kind: 'call',
      function: 'tween',
      arguments: [
        { name: 'duration', value: { kind: 'number', value: 300 } },
        { name: 'easing', value: { kind: 'reference', path: ['linear'] } },
      ],
    }
    const source: Definition = {
      ...definition,
      layers: definition.layers?.map((layer) =>
        layer.name === 'base'
          ? {
              ...layer,
              targets: [
                { name: 'body', properties: [{ name: 'scale', value: '1', timingExpression }] },
              ],
            }
          : layer,
      ),
    }
    const { instance, element, errors } = setup(source)
    instance.updateParameters({ hover: true, press: false, size: 1.4 })
    const first = instance.animations[0]
    first.pause()
    first.currentTime = 150
    const displayed = Number(getComputedStyle(element).scale)

    instance.updateParameters({ hover: false, press: false, size: 1.4 })
    const next = instance.animations[0]
    next.pause()
    next.currentTime = 0

    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(displayed)
    expect(first.playState).toBe('idle')

    next.finish()
    await next.finished
    await Promise.resolve()

    expect(element.style.scale).toBe('1')
    expect(errors).toEqual([])
  })

  it('starts an explicitly keyed track when a new owner has the same final value', async () => {
    const source = timedDefinition()
    const { instance, element } = setup({
      ...source,
      layers: [
        ...(source.layers?.slice(0, 1) ?? []),
        {
          name: 'press',
          when: ref('press'),
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: '1',
                  keyframes: [
                    { offset: 0, value: '.8' },
                    { offset: 1, value: '1' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    instance.updateParameters({ hover: false, press: true, size: 1 })
    const animation = instance.animations[0]
    animation.pause()
    animation.currentTime = 0

    expect(getComputedStyle(element).scale).toBe('0.8')

    animation.finish()
    await animation.finished
  })

  it('executes spring timing through the sampled animation curve', async () => {
    const source = timedDefinition()
    const { instance } = setup({
      ...source,
      layers: source.layers?.map((layer) =>
        layer.name === 'base'
          ? {
              ...layer,
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: '1',
                      timingExpression: { kind: 'call', function: 'spring', arguments: [] },
                    },
                  ],
                },
              ],
            }
          : layer,
      ),
    })

    instance.updateParameters({ hover: true, press: false, size: 1.4 })
    const animation = instance.animations[0]

    expect(animation.effect?.getTiming().easing).toContain('linear(')

    animation.finish()
    await animation.finished
  })

  it('settles zero-duration updates without creating effects', () => {
    const { instance, element } = setup(timedDefinition(0))

    instance.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(element.style.scale).toBe('1.4')
    expect(instance.animations).toEqual([])
  })

  it('skips animation while reduced motion is enabled', async () => {
    const session = cdp()
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    try {
      const { instance, element } = setup(timedDefinition())
      instance.updateParameters({ hover: true, press: false, size: 1.4 })

      expect(element.style.scale).toBe('1.4')
      expect(instance.animations).toEqual([])
    } finally {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      })
    }
  })

  it('keeps the resolved destination after external animation cancellation', async () => {
    const { instance, element, errors } = setup(timedDefinition())
    instance.updateParameters({ hover: true, press: false, size: 1.4 })
    const animation = instance.animations[0]

    animation.cancel()
    await Promise.resolve()
    await Promise.resolve()

    expect(element.style.scale).toBe('1.4')
    expect(instance.animations).toEqual([])
    expect(errors[0].code).toBe('runtime.animation')
  })

  it('does not apply a stale completion after a newer reactive update', async () => {
    const { instance, element } = setup(timedDefinition())
    instance.updateParameters({ hover: true, press: false, size: 1.4 })
    instance.animations[0].finish()

    instance.updateParameters({ hover: false, press: false, size: 1.4 })
    await Promise.resolve()

    expect(element.style.scale).toBe('1')
    expect(instance.animations).toHaveLength(1)
  })

  it('rolls back prepared effects when a later track has invalid easing', () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: '1',
                  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                },
                {
                  name: 'opacity',
                  value: '1',
                  timing: { kind: 'tween', durationMs: 200, easing: 'not-an-easing' },
                },
              ],
            },
          ],
        },
        {
          name: 'hover',
          when: ref('hover'),
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'scale', value: '1.4' },
                { name: 'opacity', value: '.5' },
              ],
            },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source)

    instance.updateParameters({ hover: true, press: false, size: 1 })

    expect(instance.animations).toEqual([])
    expect(element.style.scale).toBe('1')
    expect(element.style.opacity).toBe('1')
    expect(errors[0].error).toBeInstanceOf(TypeError)
  })

  it('preserves an unrelated animation across a machine transition', () => {
    const timingExpression: Expression = {
      kind: 'call',
      function: 'tween',
      arguments: [{ name: 'duration', value: { kind: 'number', value: 300 } }],
    }
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'machine',
          initialState: 'idle',
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'opacity', value: '', template: [ref('size')], timingExpression },
                { name: 'scale', value: '1', timingExpression },
              ],
            },
          ],
          states: [
            { name: 'idle', targets: [] },
            {
              name: 'open',
              targets: [{ name: 'body', properties: [{ name: 'scale', value: '1.2' }] }],
            },
          ],
          transitions: [
            { from: 'idle', to: 'open', when: ref('hover'), transition: { targets: [] } },
          ],
        },
      ],
    }
    const { instance } = setup(source, { hover: false, press: false, size: 1 })
    instance.updateParameters({ hover: false, press: false, size: 0.5 })
    const opacity = instance.animations[0]
    opacity.pause()
    opacity.currentTime = 100

    instance.updateParameters({ hover: true, press: false, size: 0.5 })

    expect(instance.animations).toContain(opacity)
    expect(opacity.currentTime).toBe(100)
    expect(opacity.playState).toBe('paused')
  })

  it('retires an obsolete directional track when the next state has the same value', () => {
    const timingExpression: Expression = { kind: 'call', function: 'tween', arguments: [] }
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'machine',
          initialState: 'closed',
          targets: [
            { name: 'body', properties: [{ name: 'scale', value: '1.1', timingExpression }] },
          ],
          states: [
            { name: 'closed', targets: [] },
            { name: 'open', targets: [] },
          ],
          transitions: [
            {
              from: 'closed',
              to: 'open',
              when: ref('hover'),
              transition: {
                targets: [
                  {
                    name: 'body',
                    properties: [{ name: 'scale', keyframes: [{ offset: 0, value: '.8' }] }],
                  },
                ],
              },
            },
            {
              from: 'open',
              to: 'closed',
              when: { kind: 'unary', operator: '!', operand: ref('hover') },
              transition: { targets: [] },
            },
          ],
        },
      ],
    }
    const { instance, element } = setup(source)
    instance.updateParameters({ hover: true, press: false, size: 1 })
    const opening = instance.animations[0]
    opening.pause()
    opening.currentTime = 0

    instance.updateParameters({ hover: false, press: false, size: 1 })
    const closing = instance.animations[0]
    closing.pause()
    closing.currentTime = 0

    expect(opening.playState).toBe('idle')
    expect(getComputedStyle(element).scale).toBe('0.8')
  })

  it('warns about a disagreeing endpoint but settles to the resolved CSS', async () => {
    const timingExpression: Expression = { kind: 'call', function: 'tween', arguments: [] }
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'machine',
          initialState: 'closed',
          targets: [
            { name: 'body', properties: [{ name: 'scale', value: '1', timingExpression }] },
          ],
          states: [
            { name: 'closed', targets: [] },
            {
              name: 'open',
              targets: [{ name: 'body', properties: [{ name: 'scale', value: '1.1' }] }],
            },
          ],
          transitions: [
            {
              from: 'closed',
              to: 'open',
              when: ref('hover'),
              transition: {
                targets: [
                  {
                    name: 'body',
                    properties: [{ name: 'scale', keyframes: [{ offset: 1, value: '2' }] }],
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source)
    instance.updateParameters({ hover: true, press: false, size: 1 })
    const animation = instance.animations[0]

    animation.finish()
    await animation.finished
    await Promise.resolve()

    expect(element.style.scale).toBe('1.1')
    expect(errors[0].code).toBe('runtime.endpoint')
  })

  it('uses different directional tracks and restores resolved styles after completion', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'visibility',
          initialState: 'closed',
          targets: [
            {
              name: 'body',
              properties: [{ name: 'scale', value: '.9', timingExpression: timing(200) }],
            },
          ],
          states: [
            { name: 'closed', targets: [] },
            {
              name: 'open',
              targets: [{ name: 'body', properties: [{ name: 'scale', value: '1.1' }] }],
            },
          ],
          transitions: [
            {
              from: 'closed',
              to: 'open',
              when: ref('hover'),
              transition: {
                targets: [
                  {
                    name: 'body',
                    properties: [
                      {
                        name: 'scale',
                        timingExpression: timing(225),
                        keyframes: [{ offset: 0.7, value: '1.2' }],
                      },
                    ],
                  },
                ],
              },
            },
            {
              from: 'open',
              to: 'closed',
              when: { kind: 'unary', operator: '!', operand: ref('hover') },
              transition: {
                targets: [
                  { name: 'body', properties: [{ name: 'scale', timingExpression: timing(75) }] },
                ],
              },
            },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source)
    instance.updateParameters({ hover: true, press: false, size: 1 })
    const opening = instance.animations[0]
    opening.pause()
    opening.currentTime = 100

    expect(opening.effect?.getTiming().duration).toBe(225)
    const effect = opening.effect

    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

    expect(effect.getKeyframes().some((frame) => frame.scale === '1.2')).toBe(true)

    instance.updateParameters({ hover: false, press: false, size: 1 })
    const closing = instance.animations[0]

    expect(closing.effect?.getTiming().duration).toBe(75)

    closing.pause()
    closing.currentTime = 37.5

    expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(0.9)
    expect(Number(getComputedStyle(element).scale)).toBeLessThan(1.2)

    closing.finish()
    await closing.finished
    await Promise.resolve()

    expect(element.style.scale).toBe('0.9')
    expect(errors).toEqual([])
  })

  it('restores original styles on disposal', () => {
    const { instance, element } = setup()

    instance.dispose()

    expect(element.style.scale).toBe('')
    expect(element.style.color).toBe('red')
  })

  it('evaluates a state machine once on initialization and each parameter update', () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'machine',
          targets: [],
          initialState: 'idle',
          states: [
            {
              name: 'idle',
              targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
            },
            {
              name: 'active',
              targets: [{ name: 'body', properties: [{ name: 'opacity', value: '.5' }] }],
            },
          ],
          transitions: [
            { from: 'idle', to: 'active', when: ref('hover'), transition: { targets: [] } },
            { from: 'active', to: 'idle', when: ref('hover'), transition: { targets: [] } },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source, { hover: true, press: false, size: 1 })

    expect(element.style.opacity).toBe('0.5')

    instance.updateParameters({ hover: true, press: false, size: 1 })

    expect(element.style.opacity).toBe('1')
    expect(errors).toEqual([])
  })
})

function start(phase: 'enter' | 'leave', instance: LivaInstance, element: HTMLElement) {
  const work = instance.captureLifecycle(phase, ['body'])
  instance.releaseLifecycle(
    ['body'],
    element,
    work.map(({ track }) => track.property),
  )

  const session = new LifecycleSession(work, phase)
  session.initialize()
  instance.retainLifecycle(phase, session)
  session.play()

  for (const animation of element.getAnimations()) {
    animation.pause()
    animation.currentTime = 0
  }

  cleanup.push(() => session.cancel('owner-teardown'))

  return session
}

describe('layer lifecycle snapshots', () => {
  const lifecycle = {
    timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
    targets: [
      { name: 'body', properties: [{ name: 'scale', keyframes: [{ offset: 0, value: '.5' }] }] },
    ],
  }

  it('holds an enter snapshot while another property changes and settles the latest values', async () => {
    const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
    const session = start('enter', instance, element)
    const effect = element.getAnimations()[0]

    instance.updateParameters({ hover: true, press: true, size: 1.4 })

    expect(element.getAnimations()).toContain(effect)
    expect(getComputedStyle(element).scale).toBe('0.5')
    expect(element.style.opacity).toBe('0.5')

    if (!(effect.effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

    expect(effect.effect.getKeyframes().at(-1)?.scale).toBe('1')

    effect.finish()

    await session.finished

    expect(element.style.scale).toBe('0.9')
    expect(element.style.opacity).toBe('0.5')
  })

  it.each(['finished', 'reduced motion'] as const)(
    'restores removed enter properties when the session ends through %s',
    async (reason) => {
      const source = {
        ...definition,
        layers: definition.layers?.filter((layer) => layer.name === 'press'),
        enter: lifecycle,
      }
      const { instance, element } = setup(source, { hover: false, press: true, size: 1 })
      const session = start('enter', instance, element)

      instance.updateParameters({ hover: false, press: false, size: 1 })

      expect(getComputedStyle(element).scale).toBe('0.5')

      try {
        if (reason === 'reduced motion') {
          await cdp().send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
          })
        } else {
          for (const animation of element.getAnimations()) animation.finish()
        }

        await session.finished

        expect(element.style.scale).toBe('')
        expect(element.style.opacity).toBe('')
        expect(element.style.color).toBe('red')
      } finally {
        if (reason === 'reduced motion') {
          await cdp().send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
          })
        }
      }
    },
  )

  it('preserves enter presentation across target rebinding', async () => {
    const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
    instance.updateParameters({ hover: true, press: false, size: 1.4 })
    const session = start('enter', instance, element)
    const other = document.createElement('div')
    document.body.append(other)
    cleanup.push(() => other.remove())

    instance.bind([
      ['body', element],
      ['extra', other],
    ])

    expect(getComputedStyle(element).scale).toBe('0.5')

    for (const animation of element.getAnimations()) animation.finish()

    await session.finished

    expect(element.style.scale).toBe('1.4')
  })

  it('releases enter properties outside the layer cascade back to stylesheet control', async () => {
    const stylesheet = document.createElement('style')
    stylesheet.textContent = '.lifecycle-fallback { opacity: .8 }'
    document.head.append(stylesheet)
    cleanup.push(() => stylesheet.remove())

    const enter = {
      ...lifecycle,
      targets: [
        { name: 'body', properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: '0' }] }] },
      ],
    }
    const { instance, element } = setup({ ...timedDefinition(), enter })
    element.className = 'lifecycle-fallback'
    const session = start('enter', instance, element)

    for (const animation of element.getAnimations()) animation.finish()

    await session.finished

    expect(element.style.opacity).toBe('')
    expect(getComputedStyle(element).opacity).toBe('0.8')

    stylesheet.textContent = '.lifecycle-fallback { opacity: .2 }'

    expect(getComputedStyle(element).opacity).toBe('0.2')
  })

  async function completeWithRegistrations(count: number) {
    const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
    const session = start('enter', instance, element)
    const writes = vi.spyOn(element.style, 'setProperty')

    for (let index = 1; index < count; index++) instance.retainLifecycle('enter', session)

    for (const animation of element.getAnimations()) animation.finish()

    await session.finished

    expect(element.style.scale).toBe('1')

    const countWrites = writes.mock.calls.length

    writes.mockRestore()

    return countWrites
  }

  it('does not repeat completion writes when multiple targets retain the same session', async () => {
    const single = await completeWithRegistrations(1)
    const repeated = await completeWithRegistrations(5)

    expect(repeated).toBe(single)
  })

  it.each([false, true])(
    'settles boundaries without disturbing unfinished enters (together=%s)',
    async (together) => {
      const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
      const other = document.createElement('div')
      document.body.append(other)
      cleanup.push(() => other.remove())
      instance.bind([
        ['body', element],
        ['body', other],
      ])

      const first = new LifecycleSession(
        instance.captureLifecycle('enter', ['body'], element),
        'enter',
      )
      const second = new LifecycleSession(
        instance.captureLifecycle('enter', ['body'], other),
        'enter',
      )

      for (const session of [first, second]) {
        session.initialize()
        instance.retainLifecycle('enter', session)
        session.play()

        cleanup.push(() => session.cancel('owner-teardown'))
      }

      for (const target of [element, other]) {
        for (const animation of target.getAnimations()) {
          animation.pause()
          animation.currentTime = 0
        }
      }

      instance.updateParameters({ hover: true, press: false, size: 1.4 })
      const writes = vi.spyOn(element.style, 'setProperty')

      for (const animation of element.getAnimations()) animation.finish()

      if (together) {
        for (const animation of other.getAnimations()) animation.finish()
      }

      await first.finished

      expect(element.style.scale).toBe('1.4')
      expect(
        writes.mock.calls.filter(([property, value]) => property === 'scale' && value === '1.4'),
      ).toHaveLength(1)
      expect(getComputedStyle(other).scale).toBe(together ? '1.4' : '0.5')

      for (const animation of other.getAnimations()) animation.finish()

      await second.finished

      expect(other.style.scale).toBe('1.4')

      writes.mockRestore()
    },
  )

  it('keeps a leave snapshot while layers change and permits unrelated updates', async () => {
    const leave = {
      ...lifecycle,
      targets: [
        { name: 'body', properties: [{ name: 'scale', keyframes: [{ offset: 1, value: '.5' }] }] },
      ],
    }
    const { instance, element } = setup({ ...timedDefinition(), leave })
    const session = start('leave', instance, element)
    const effect = element.getAnimations()[0]

    instance.updateParameters({ hover: true, press: true, size: 1.4 })

    expect(element.getAnimations()).toContain(effect)

    if (!(effect.effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

    expect(effect.effect.getKeyframes().map((frame) => frame.scale)).toEqual(['1', '0.5'])
    expect(element.style.opacity).toBe('0.5')

    effect.finish()

    expect(await session.finished).toBe('completed')
  })
})
