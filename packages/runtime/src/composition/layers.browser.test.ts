import { LifecycleSession } from '../execution/lifecycle.ts'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import { LivaInstance, type RuntimeDiagnostic } from '../execution/instance.ts'
import { decodeBundle, type Definition, type Expression } from '../model/definition.ts'

const ref = (name: string): Expression => ({ kind: 'reference', path: [name] })
const definition: Definition = {
  name: 'button',
  parameters: [
    { name: 'hover', type: 'boolean' },
    { name: 'press', type: 'boolean' },
    { name: 'size', type: 'number' },
  ],
  layers: [
    {
      name: 'base',
      targets: [
        {
          name: 'body',
          properties: [
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
    {
      name: 'hover',
      when: ref('hover'),
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'scale',
              value: {
                kind: 'template',
                parts: [ref('size')],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'press',
      when: ref('press'),
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'scale',
              value: {
                kind: 'literal',
                value: '.9',
              },
            },
            {
              name: 'opacity',
              value: {
                kind: 'literal',
                value: '.5',
              },
            },
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
    layers: definition.layers.map((layer) =>
      layer.name === 'base'
        ? {
            ...layer,
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'scale',
                    value: {
                      kind: 'literal',
                      value: '1',
                    },
                    timingExpression,
                  },
                ],
              },
            ],
          }
        : layer,
    ),
  }
}

function instantTrackDefinition(): Definition {
  return {
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
                value: {
                  kind: 'literal',
                  value: '1',
                },
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
              {
                name: 'scale',
                value: {
                  kind: 'keyframes',
                  frames: [
                    {
                      offset: 0,
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                    },
                    {
                      offset: 0.5,
                      value: {
                        kind: 'literal',
                        value: '5',
                      },
                    },
                    {
                      offset: 1,
                      value: {
                        kind: 'literal',
                        value: '2',
                      },
                    },
                  ],
                },
                timingExpression: ref('instant'),
              },
            ],
          },
        ],
      },
    ],
  }
}

async function setReducedMotion(reduced: boolean) {
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }],
  })

  // Media-query changes are dispatched during rendering, after the CDP command completes.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(reduced)
}

const cleanup: (() => void)[] = []

function setup(
  source = definition,
  inputs: ConstructorParameters<typeof LivaInstance>[1] = { hover: false, press: false, size: 1.1 },
) {
  const errors: RuntimeDiagnostic[] = []
  const element = document.createElement('div')
  element.style.color = 'red'
  document.body.append(element)
  const decoded = decodeBundle(JSON.stringify({ schemaVersion: 2, definitions: [source] }))
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
  it.each(['tween', 'spring'] as const)(
    'Instant interrupts an active %s and restores inherited timing',
    async (kind) => {
      const inherited: Expression =
        kind === 'tween' ? timing(300) : { kind: 'call', function: 'spring', arguments: [] }
      const source: Definition = {
        ...definition,
        layers: [
          {
            name: 'base',
            timingExpression: inherited,
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'scale',
                    value: {
                      kind: 'literal',
                      value: '1',
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
            ],
          },
          {
            name: 'hover',
            when: ref('hover'),
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'scale',
                    value: {
                      kind: 'literal',
                      value: '1.2',
                    },
                  },
                  {
                    name: 'opacity',
                    value: {
                      kind: 'literal',
                      value: '.5',
                    },
                  },
                ],
              },
            ],
          },
          {
            name: 'press',
            when: ref('press'),
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'scale',
                    value: {
                      kind: 'template',
                      parts: [ref('size')],
                    },
                    timingExpression: ref('instant'),
                  },
                ],
              },
            ],
          },
        ],
      }
      const { instance, element, errors } = setup(source)
      instance.updateParameters({ hover: true, press: false, size: 1.4 })
      const obsolete = [...instance.animations]

      expect(obsolete).toHaveLength(2)

      instance.updateParameters({ hover: true, press: true, size: 1.4 })

      expect(getComputedStyle(element).scale).toBe('1.4')
      expect(instance.animations).toHaveLength(1)
      expect(instance.animations[0]).toBe(obsolete[1])
      expect(obsolete[0].playState).toBe('idle')

      await new Promise(requestAnimationFrame)

      expect(getComputedStyle(element).scale).toBe('1.4')

      instance.updateParameters({ hover: true, press: false, size: 1.4 })

      expect(instance.animations).toHaveLength(2)
      const returning = instance.animations.find((animation) => animation !== obsolete[1])

      expect(returning).toBeDefined()
      returning!.finish()
      await returning!.finished
      await Promise.resolve()

      expect(getComputedStyle(element).scale).toBe('1.2')
      expect(errors).toEqual([])
    },
  )

  it('Instant tracks settle at their destination without intermediate application frames', () => {
    const { instance, element } = setup(instantTrackDefinition())

    instance.updateParameters({ hover: true, press: false, size: 1 })

    expect(instance.animations).toHaveLength(0)
    expect(getComputedStyle(element).scale).toBe('2')
  })

  it('Instant track preview scrubbing stays at the resolved destination', () => {
    const { instance, element } = setup(instantTrackDefinition())
    const from = { layers: { base: true, hover: false }, states: {} }
    const to = { layers: { base: true, hover: true }, states: {} }
    instance.previewComposition(from, to)

    for (const time of [0, 100, 0]) {
      for (const animation of instance.animations) animation.currentTime = time

      expect(getComputedStyle(element).scale).toBe('2')
    }
  })

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

  it('exposes the current layer composition', () => {
    const { instance } = setup()

    expect(instance.composition).toEqual({
      layers: { base: true, hover: false, press: false },
      states: {},
    })
  })

  it('replaces layer definitions using current parameter values', () => {
    const { instance, element } = setup(definition, { hover: true, press: false, size: 1.4 })

    instance.replaceDefinition({ ...definition, layers: definition.layers.slice(0, 1) })

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
        {
          name: 'drag',
          when: { kind: 'reference', path: ['dragging', 'active'] },
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '.5',
                  },
                },
              ],
            },
          ],
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
    instance.onUpdate = () => {
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
      layers: definition.layers.map((layer) =>
        layer.name === 'base'
          ? {
              ...layer,
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                      timingExpression,
                    },
                  ],
                },
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
                  value: {
                    kind: 'keyframes',
                    frames: [
                      {
                        offset: 0,
                        value: {
                          kind: 'literal',
                          value: '.8',
                        },
                      },
                      {
                        offset: 1,
                        value: {
                          kind: 'literal',
                          value: '1',
                        },
                      },
                    ],
                  },
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
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
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
    await setReducedMotion(true)

    try {
      const { instance, element } = setup(timedDefinition())
      instance.updateParameters({ hover: true, press: false, size: 1.4 })

      expect(element.style.scale).toBe('1.4')
      expect(instance.animations).toEqual([])
    } finally {
      await setReducedMotion(false)
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
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                },
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
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
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1.4',
                  },
                },
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '.5',
                  },
                },
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
                {
                  name: 'opacity',
                  value: {
                    kind: 'template',
                    parts: [ref('size')],
                  },
                  timingExpression,
                },
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                  timingExpression,
                },
              ],
            },
          ],
          states: [
            { name: 'idle', targets: [] },
            {
              name: 'open',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1.2',
                      },
                    },
                  ],
                },
              ],
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
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1.1',
                  },
                  timingExpression,
                },
              ],
            },
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
                    properties: [
                      {
                        name: 'scale',
                        keyframes: [
                          {
                            offset: 0,
                            value: {
                              kind: 'literal',
                              value: '.8',
                            },
                          },
                        ],
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
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                  timingExpression,
                },
              ],
            },
          ],
          states: [
            { name: 'closed', targets: [] },
            {
              name: 'open',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1.1',
                      },
                    },
                  ],
                },
              ],
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
                        keyframes: [
                          {
                            offset: 1,
                            value: {
                              kind: 'literal',
                              value: '2',
                            },
                          },
                        ],
                      },
                    ],
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
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '.9',
                  },
                  timingExpression: timing(200),
                },
              ],
            },
          ],
          states: [
            { name: 'closed', targets: [] },
            {
              name: 'open',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1.1',
                      },
                    },
                  ],
                },
              ],
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
                        keyframes: [
                          {
                            offset: 0.7,
                            value: {
                              kind: 'literal',
                              value: '1.2',
                            },
                          },
                        ],
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
            {
              name: 'active',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'opacity',
                      value: {
                        kind: 'literal',
                        value: '.5',
                      },
                    },
                  ],
                },
              ],
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

/** Dispatches a native media-query event in the test's call stack, before Promise callbacks can run. */
function setupWithSynchronousMotionChange(
  source: Definition,
  inputs: ConstructorParameters<typeof LivaInstance>[1],
) {
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const observe = vi.spyOn(window, 'matchMedia').mockReturnValue(media)

  try {
    const fixture = setup(source, inputs)

    return {
      ...fixture,
      reduceMotion: () => {
        const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(true)
        cleanup.push(() => matches.mockRestore())

        media.dispatchEvent(new Event('change'))
      },
    }
  } finally {
    observe.mockRestore()
  }
}

describe('layer lifecycle snapshots', () => {
  const lifecycle: import('../model/definition.ts').Transition = {
    timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
    targets: [
      {
        name: 'body',
        properties: [
          {
            name: 'scale',
            keyframes: [
              {
                offset: 0,
                value: {
                  kind: 'literal',
                  value: '.5',
                },
              },
            ],
          },
        ],
      },
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

  it('restores removed enter styles synchronously on cancellation while preserving a running leave', async () => {
    const source: Definition = {
      ...definition,
      layers: definition.layers.filter((layer) => layer.name === 'press'),
      enter: lifecycle,
      leave: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors, reduceMotion } = setupWithSynchronousMotionChange(source, {
      hover: false,
      press: true,
      size: 1,
    })
    const enter = start('enter', instance, element)
    const leave = start('leave', instance, element)
    const effects = element.getAnimations()

    expect(effects).toHaveLength(2)

    effects[1].currentTime = 500
    instance.updateParameters({ hover: false, press: false, size: 1 })

    expect(getComputedStyle(element).scale).toBe('0.5')

    reduceMotion()

    // These checks run before the cancelled session's resolved Promise is delivered.
    expect(enter.isFinished).toBe(true)
    expect(element.style.scale).toBe('')
    expect(element.style.opacity).toBe('0.5')
    expect(leave.isFinished).toBe(false)
    expect(element.getAnimations()).toHaveLength(1)
    expect(getComputedStyle(element).opacity).toBe('0.25')

    expect(await enter.finished).toBe('superseded')
    expect(errors).toEqual([])
  })

  it.each(['preview', 'replacement'] as const)(
    'ignores queued enter completion after cancellation through %s',
    async (operation) => {
      const source = { ...timedDefinition(), enter: lifecycle }
      const { instance, element } = setup(source)
      const session = start('enter', instance, element)

      if (operation === 'preview') {
        instance.previewComposition(instance.composition, instance.composition)
        instance.endCompositionPreview()
      } else {
        instance.replaceDefinition(source)
      }

      expect(session.isFinished).toBe(true)

      element.style.scale = '1.7'

      await session.finished

      expect(element.style.scale).toBe('1.7')
    },
  )

  it('does not register an already finished lifecycle session for later restoration', async () => {
    const { instance, element } = setup(timedDefinition())
    const session = new LifecycleSession([], 'enter')
    session.cancel('superseded')

    instance.retainLifecycle('enter', session)
    element.style.scale = '1.7'

    await session.finished

    expect(element.style.scale).toBe('1.7')
  })

  it.each(['finished', 'reduced motion'] as const)(
    'restores removed enter properties when the session ends through %s',
    async (reason) => {
      const source = {
        ...definition,
        layers: definition.layers.filter((layer) => layer.name === 'press'),
        enter: lifecycle,
      }
      const { instance, element } = setup(source, { hover: false, press: true, size: 1 })
      const session = start('enter', instance, element)

      instance.updateParameters({ hover: false, press: false, size: 1 })

      expect(getComputedStyle(element).scale).toBe('0.5')

      try {
        if (reason === 'reduced motion') {
          await setReducedMotion(true)
        } else {
          for (const animation of element.getAnimations()) animation.finish()
        }

        await session.finished

        expect(element.style.scale).toBe('')
        expect(element.style.opacity).toBe('')
        expect(element.style.color).toBe('red')
      } finally {
        if (reason === 'reduced motion') {
          await setReducedMotion(false)
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

    const enter: import('../model/definition.ts').Transition = {
      ...lifecycle,
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'opacity',
              keyframes: [
                {
                  offset: 0,
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
          ],
        },
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
    const leave: import('../model/definition.ts').Transition = {
      ...lifecycle,
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'scale',
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '.5',
                  },
                },
              ],
            },
          ],
        },
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

describe('composition preview sessions', () => {
  const from = { layers: { base: true, hover: false, press: false }, states: {} }
  const to = { layers: { base: true, hover: true, press: false }, states: {} }

  it('scrubs both directions without changing application composition and restores on end', async () => {
    const { instance, element, errors } = setup(timedDefinition(200))

    instance.previewComposition(from, to)
    const animation = instance.animations[0]
    await animation.ready
    animation.currentTime = 100

    expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(1)
    expect(instance.composition).toEqual(from)

    animation.currentTime = 200
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1.1)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)

    instance.endCompositionPreview()

    expect(instance.animations).toHaveLength(0)
    expect(element.style.scale).toBe('1')
    expect(errors).toEqual([])
  })

  it('isolates candidate definitions and restores the latest input update', () => {
    const first = setup(timedDefinition())
    const second = setup(timedDefinition())
    const original = first.instance.definition
    const candidate: Definition = {
      ...original,
      layers: original.layers?.map((layer) =>
        layer.name === 'hover'
          ? {
              ...layer,
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '2',
                      },
                    },
                  ],
                },
              ],
            }
          : layer,
      ),
    }

    first.instance.previewComposition(from, to, [], candidate)

    expect(first.instance.definition).toBe(original)
    expect(second.instance.animations).toHaveLength(0)
    expect(second.element.style.scale).toBe('1')

    first.instance.updateParameters({ hover: true, press: false, size: 1.4 })
    first.instance.endCompositionPreview()

    expect(first.instance.composition).toEqual(to)
    expect(first.element.style.scale).toBe('1.4')
  })

  it('restores external CSS when the application has no active property', () => {
    const source = timedDefinition()
    const { instance, element } = setup({
      ...source,
      layers: source.layers?.filter((layer) => layer.name !== 'base'),
    })
    element.style.scale = '.7'
    const off = { layers: { hover: false, press: false }, states: {} }
    const on = { layers: { hover: true, press: false }, states: {} }

    instance.previewComposition(off, on)
    expect(element.style.scale).toBe('1.1')

    instance.endCompositionPreview()
    expect(element.style.scale).toBe('0.7')
  })

  it('keeps application machine history while previewing another state', () => {
    const { instance } = setup(
      {
        ...timedDefinition(),
        layers: [
          {
            name: 'machine',
            targets: [],
            initialState: 'idle',
            states: [
              {
                name: 'idle',
                targets: [
                  {
                    name: 'body',
                    properties: [
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
              {
                name: 'done',
                targets: [
                  {
                    name: 'body',
                    properties: [
                      {
                        name: 'scale',
                        value: {
                          kind: 'literal',
                          value: '2',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
            transitions: [
              { from: 'idle', to: 'done', when: ref('hover'), transition: { targets: [] } },
            ],
          },
        ],
      },
      { hover: true, press: false, size: 1.1 },
    )
    const idle = { layers: {}, states: { machine: 'idle' } }
    const done = { layers: {}, states: { machine: 'done' } }

    instance.previewComposition(done, idle)
    instance.endCompositionPreview()
    instance.updateParameters({ hover: false, press: false, size: 1.1 })

    expect(instance.composition).toEqual(done)
  })

  it('releases preview effects on unmount and rejects further previews', () => {
    const { instance, element } = setup(timedDefinition())

    instance.previewComposition(from, to)
    instance.dispose()

    expect(instance.animations).toHaveLength(0)
    expect(element.style.scale).toBe('')
    expect(() => instance.previewComposition(from, to)).toThrow('mounted layer instance')
  })

  it('keeps paused scrubbing available across reduced-motion changes', async () => {
    const { instance, element } = setup(timedDefinition(200))

    await setReducedMotion(true)

    try {
      instance.previewComposition(from, to)
      const animation = instance.animations[0]
      await animation.ready
      animation.currentTime = 100

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(1)
      expect(Number(getComputedStyle(element).scale)).toBeLessThan(1.1)

      await setReducedMotion(false)
      animation.currentTime = 0

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)
    } finally {
      instance.endCompositionPreview()
      await setReducedMotion(false)
    }
  })

  it('scrubs duration springs using the existing sampler', async () => {
    const source = timedDefinition()
    const { instance, element } = setup({
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
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                      timing: { kind: 'spring-duration', durationMs: 400, bounce: 0.2 },
                    },
                  ],
                },
              ],
            }
          : layer,
      ),
    })

    instance.previewComposition(from, to)
    const animation = instance.animations[0]
    await animation.ready
    animation.currentTime = 400

    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1.1)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)
  })

  it('ends previews when targets are removed', () => {
    const { instance, element } = setup(timedDefinition())

    instance.previewComposition(from, to)
    instance.bind([])

    expect(element.style.scale).toBe('')
    expect(instance.animations).toHaveLength(0)
    expect(() => instance.previewComposition(from, to)).toThrow('mounted layer instance')
  })

  it('ends previews when the definition is replaced', () => {
    const { instance, element } = setup(timedDefinition())

    instance.previewComposition(from, to)
    instance.replaceDefinition(definition)

    expect(element.style.scale).toBe('1')
    expect(instance.animations).toHaveLength(0)
  })

  it('animates equal compositions with intermediate style motion', async () => {
    const { instance, element } = setup({
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
                  value: {
                    kind: 'keyframes',
                    frames: [
                      {
                        offset: 0.5,
                        value: {
                          kind: 'literal',
                          value: '2',
                        },
                      },
                      {
                        offset: 1,
                        value: {
                          kind: 'literal',
                          value: '1',
                        },
                      },
                    ],
                  },
                  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                },
              ],
            },
          ],
        },
      ],
    })
    const composition = { layers: { base: true }, states: {} }

    instance.previewComposition(composition, composition)
    const animation = instance.animations[0]
    await animation.ready
    animation.currentTime = 100

    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(2)
  })

  it('reports explicit endpoint disagreement and restores the resolved destination', () => {
    const { instance, errors } = setup({
      ...definition,
      layers: [
        {
          name: 'machine',
          targets: [],
          initialState: 'idle',
          states: [
            {
              name: 'idle',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                      timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                    },
                  ],
                },
              ],
            },
          ],
          transitions: [
            {
              from: 'idle',
              to: 'idle',
              when: ref('hover'),
              transition: {
                targets: [
                  {
                    name: 'body',
                    properties: [
                      {
                        name: 'scale',
                        keyframes: [
                          {
                            offset: 1,
                            value: {
                              kind: 'literal',
                              value: '2',
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    const composition = { layers: {}, states: { machine: 'idle' } }

    instance.previewComposition(composition, composition, [{ layer: 'machine', index: 0 }])

    expect(errors.at(-1)?.code).toBe('runtime.endpoint')
  })

  it('previews mounted targets while lifecycle-managed targets are absent', () => {
    const source = timedDefinition()
    const { instance, element } = setup({
      ...source,
      enter: { targets: [] },
      layers: [
        ...(source.layers ?? []),
        {
          name: 'optional',
          targets: [
            {
              name: 'absent',
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
    })
    const before = { ...from, layers: { ...from.layers, optional: true } }
    const after = { ...to, layers: { ...to.layers, optional: true } }

    instance.previewComposition(before, after)

    expect(instance.animations).toHaveLength(1)

    instance.endCompositionPreview()

    expect(element.style.scale).toBe('1')
  })

  it('cancels partially prepared effects when a later effect fails', () => {
    const source = timedDefinition()
    const { instance, element, errors } = setup({
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
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                      timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                    },
                    {
                      name: 'opacity',
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                      timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                    },
                  ],
                },
              ],
            }
          : layer,
      ),
    })
    const NativeAnimation = Animation
    const cancellations: MockInstance<() => void>[] = []
    vi.stubGlobal(
      'Animation',
      vi.fn(function (effect: AnimationEffect, timeline: AnimationTimeline) {
        const animation = new NativeAnimation(effect, timeline)
        cancellations.push(vi.spyOn(animation, 'cancel'))

        return animation
      }),
    )
    const NativeEffect = KeyframeEffect
    const original = new Error('second effect failure')
    let created = 0
    vi.stubGlobal(
      'KeyframeEffect',
      vi.fn(function (...args: ConstructorParameters<typeof KeyframeEffect>) {
        if (++created === 2) throw original

        return new NativeEffect(...args)
      }),
    )

    try {
      expect(() => instance.previewComposition(from, to)).toThrow(
        'Could not prepare composition preview',
      )
      expect(cancellations).toHaveLength(1)
      expect(cancellations[0]).toHaveBeenCalledExactlyOnceWith()
      expect(element.getAnimations()).toHaveLength(0)
      expect(instance.animations).toHaveLength(0)
      expect(errors.at(-1)?.error).toMatchObject({ cause: original })
      expect(element.style.scale).toBe('1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns preparation failures with their original causes and restores the application', () => {
    const { instance, element, errors } = setup(timedDefinition())
    const original = new Error('effect failure')
    vi.stubGlobal(
      'KeyframeEffect',
      vi.fn(function () {
        throw original
      }),
    )

    try {
      expect(() => instance.previewComposition(from, to)).toThrow(
        'Could not prepare composition preview',
      )
      expect(errors.at(-1)?.error).toMatchObject({ cause: original })
      expect(instance.animations).toHaveLength(0)
      expect(element.style.scale).toBe('1')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('typed timing playback', () => {
  it.each([
    { position: 'start', initial: 0.5, middle: 1 },
    { position: 'end', initial: 0, middle: 0.5 },
    { position: 'jump-start', initial: 0.5, middle: 1 },
    { position: 'jump-end', initial: 0, middle: 0.5 },
    { position: 'jump-none', initial: 0, middle: 1 },
    { position: 'jump-both', initial: 1 / 3, middle: 2 / 3 },
  ])(
    'preserves browser step discontinuities for $position',
    async ({ position, initial, middle }) => {
      const source: Definition = {
        name: 'steps',
        parameters: [
          { name: 'amount', type: 'number' },
          { name: 'count', type: 'number' },
        ],
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
                      kind: 'template',
                      parts: [ref('amount')],
                    },
                    timingExpression: {
                      kind: 'call',
                      function: 'tween',
                      arguments: [
                        { name: 'duration', value: { kind: 'number', value: 1000 } },
                        {
                          name: 'easing',
                          value: {
                            kind: 'call',
                            function: 'steps',
                            arguments: [
                              { name: 'count', value: ref('count') },
                              { name: 'position', value: { kind: 'string', value: position } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }
      const { instance, element } = setup(source, { amount: 0, count: 2 })

      instance.updateParameters({ amount: 1, count: 2 })
      const animation = instance.animations[0]
      await animation.ready
      animation.pause()
      animation.currentTime = 0

      expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(initial)

      animation.currentTime = 499
      expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(initial)

      animation.currentTime = 500
      expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(middle)
    },
  )

  it('retains step timing inputs and presentation after runtime argument rejection', () => {
    const source: Definition = {
      name: 'step-rollback',
      parameters: [
        { name: 'amount', type: 'number' },
        { name: 'count', type: 'number' },
        { name: 'position', type: 'string' },
      ],
      letBindings: [
        { name: 'selected', initializer: ref('position') },
        {
          name: 'curve',
          initializer: {
            kind: 'call',
            function: 'steps',
            arguments: [
              { name: 'count', value: ref('count') },
              { name: 'position', value: ref('position') },
            ],
          },
        },
      ],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: { kind: 'template', parts: [ref('amount')] },
                  timingExpression: {
                    kind: 'call',
                    function: 'tween',
                    arguments: [
                      { name: 'duration', value: { kind: 'number', value: 0 } },
                      { name: 'easing', value: ref('curve') },
                    ],
                  },
                },
                { name: '--position', value: { kind: 'template', parts: [ref('selected')] } },
              ],
            },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source, { amount: 0.25, count: 4, position: 'end' })

    instance.updateParameters({ amount: 0.75, count: 4, position: 'start' })

    expect(element.style.opacity).toBe('0.75')
    expect(element.style.getPropertyValue('--position')).toBe('start')

    for (const args of [
      { count: 0, position: 'end' },
      { count: 1, position: 'jump-none' },
      { count: 2, position: 'middle' },
    ]) {
      instance.updateParameters({ amount: 1, ...args })

      expect(errors.at(-1)?.code).toBe('runtime.expression')
      expect(element.style.opacity).toBe('0.75')
      expect(element.style.getPropertyValue('--position')).toBe('start')
    }

    expect(errors).toHaveLength(3)

    instance.replaceDefinition(structuredClone(source))

    expect(element.style.opacity).toBe('0.75')
    expect(element.style.getPropertyValue('--position')).toBe('start')

    instance.updateParameters({ amount: 0.5, count: 2, position: 'end' })

    expect(element.style.opacity).toBe('0.5')
    expect(element.style.getPropertyValue('--position')).toBe('end')
  })

  it('scrubs a typed duration spring from a shared transition default', async () => {
    const source: Definition = {
      name: 'duration',
      parameters: [
        { name: 'duration', type: 'number' },
        { name: 'bounce', type: 'number' },
      ],
      layers: [
        {
          name: 'machine',
          targets: [],
          initialState: 'idle',
          states: [
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
                        value: '0',
                      },
                    },
                  ],
                },
              ],
            },
            {
              name: 'active',
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
          transitions: [
            {
              from: 'idle',
              to: 'active',
              when: { kind: 'boolean', value: false },
              transition: {
                targets: [],
                timingExpression: {
                  kind: 'call',
                  function: 'spring',
                  arguments: [
                    { name: 'duration', value: ref('duration') },
                    { name: 'bounce', value: ref('bounce') },
                  ],
                },
              },
            },
          ],
        },
      ],
    }
    const { instance, element } = setup(source, { duration: 400, bounce: 0.25 })

    instance.previewComposition(
      { layers: {}, states: { machine: 'idle' } },
      { layers: {}, states: { machine: 'active' } },
      [{ layer: 'machine', index: 0 }],
    )
    const animation = instance.animations[0]
    await animation.ready

    expect(animation.effect?.getTiming().duration).toBe(400)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(0)

    animation.currentTime = 400
    expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(1)

    instance.endCompositionPreview()
    expect(element.style.opacity).toBe('0')
  })
})

describe('composition lifecycle previews', () => {
  it('samples lifecycle-only targets independently and yields to parameter updates', async () => {
    const source: Definition = {
      ...definition,
      leave: {
        timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
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
            ],
          },
          {
            name: 'badge',
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
            ],
          },
        ],
      },
    }
    const { instance, element } = setup(source)
    const badge = document.createElement('div')
    badge.style.opacity = '0.6'
    document.body.append(badge)
    cleanup.push(() => badge.remove())
    instance.bind([
      ['body', element],
      ['badge', badge],
    ])

    instance.previewLifecycle('leave', {
      layers: { base: true, hover: false, press: false },
      states: {},
    })

    await Promise.all(instance.animations.map((animation) => animation.ready))

    for (const animation of instance.animations) animation.currentTime = 100

    expect(Number(getComputedStyle(badge).opacity)).toBeCloseTo(0.3)
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(0.5)

    instance.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(instance.animations).toHaveLength(0)
    expect(badge.style.opacity).toBe('0.6')
    expect(element.style.scale).toBe('1.4')
  })

  it.each(['enter', 'leave'] as const)(
    'scrubs %s against an explicit baseline and restores the application composition',
    async (phase) => {
      const source: Definition = {
        ...definition,
        [phase]: {
          timingExpression: {
            kind: 'call',
            function: 'tween',
            arguments: [{ name: 'duration', value: { kind: 'number', value: 200 } }],
          },
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  keyframes: [
                    { offset: phase === 'enter' ? 0 : 1, value: { kind: 'literal', value: '0' } },
                  ],
                },
              ],
            },
          ],
        },
      }
      const { instance, element } = setup(source)
      const baseline = { layers: { base: true, hover: true, press: false }, states: {} }
      const original = instance.composition

      instance.previewLifecycle(phase, baseline)

      const animation = instance.animations[0]

      await animation.ready

      animation.currentTime = 100

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(0)
      expect(Number(getComputedStyle(element).scale)).toBeLessThan(1.1)
      expect(instance.composition).toEqual(original)
      expect(element.isConnected).toBe(true)

      animation.currentTime = 200

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(phase === 'enter' ? 1.1 : 0)

      animation.currentTime = 0

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(phase === 'enter' ? 0 : 1.1)

      instance.endCompositionPreview()

      expect(element.style.scale).toBe('1')
      expect(instance.animations).toHaveLength(0)
    },
  )
})
