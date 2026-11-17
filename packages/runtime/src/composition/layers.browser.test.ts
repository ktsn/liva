import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import { PresenceOperation } from '../execution/presence-operation.ts'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { RuntimeDiagnostic } from '../execution/execution-contracts.ts'
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
  inputs: Parameters<typeof assembleRuntime>[1] = { hover: false, press: false, size: 1.1 },
) {
  const errors: RuntimeDiagnostic[] = []
  const element = document.createElement('div')
  element.style.color = 'red'
  document.body.append(element)
  const decoded = decodeBundle(JSON.stringify({ schemaVersion: 3, definitions: [source] }))
    .definitions[0]
  const instance = assembleRuntime(decoded, inputs, (error) => errors.push(error))
  instance.executor.bind([['body', element]])
  cleanup.push(() => {
    instance.runtime.dispose()
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
      instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
      const obsolete = [...nativeEffects(instance.executor)]

      expect(obsolete).toHaveLength(2)

      instance.runtime.updateParameters({ hover: true, press: true, size: 1.4 })

      expect(getComputedStyle(element).scale).toBe('1.4')
      expect(nativeEffects(instance.executor)).toHaveLength(1)
      expect(nativeEffects(instance.executor)[0]).toBe(obsolete[1])
      expect(obsolete[0].playState).toBe('idle')

      await new Promise(requestAnimationFrame)

      expect(getComputedStyle(element).scale).toBe('1.4')

      instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

      expect(nativeEffects(instance.executor)).toHaveLength(2)
      const returning = nativeEffects(instance.executor).find(
        (animation) => animation !== obsolete[1],
      )

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

    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })

    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(getComputedStyle(element).scale).toBe('2')
  })

  it('Instant track preview scrubbing stays at the resolved destination', () => {
    const { instance, element } = setup(instantTrackDefinition())
    const from = { layers: { base: true, hover: false }, states: {} }
    const to = { layers: { base: true, hover: true }, states: {} }
    instance.inspection.previewComposition(from, to)

    for (const time of [0, 100, 0]) {
      for (const animation of nativeEffects(instance.executor)) animation.currentTime = time

      expect(getComputedStyle(element).scale).toBe('2')
    }
  })

  it('resolves overlap and interpolation updates while preserving unrelated styles', () => {
    const { instance, element, errors } = setup()

    instance.runtime.updateParameters({ hover: true, press: true, size: 1.2 })

    expect(element.style.scale).toBe('0.9')
    expect(element.style.opacity).toBe('0.5')

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.3 })

    expect(element.style.scale).toBe('1.3')
    expect(element.style.opacity).toBe('')
    expect(element.style.color).toBe('red')
    expect(errors).toEqual([])
  })

  it('does not collide between instances with the same target names', () => {
    const first = setup()
    const second = setup()

    first.instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(first.element.style.scale).toBe('1.4')
    expect(second.element.style.scale).toBe('1')
  })

  it('exposes the current layer composition', () => {
    const { instance } = setup()

    expect(instance.runtime.composition).toEqual({
      layers: { base: true, hover: false, press: false },
      states: {},
    })
  })

  it('replaces layer definitions using current parameter values', () => {
    const { instance, element } = setup(definition, { hover: true, press: false, size: 1.4 })

    instance.runtime.replaceDefinition({ ...definition, layers: definition.layers.slice(0, 1) })

    expect(element.style.scale).toBe('1')
  })

  it('accepts updates before targets are bound without writing to other elements', () => {
    const { instance, element, errors } = setup()
    instance.executor.bind([])

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.5 })

    expect(element.style.scale).toBe('')

    instance.executor.bind([['body', element]])
    instance.runtime.updateParameters({ hover: true, press: false, size: 1.5 })

    expect(element.style.scale).toBe('1.5')
    expect(errors[0].code).toBe('runtime.targets')
  })

  it('keeps reactive updates ready while a lifecycle target is absent', () => {
    const { instance, element, errors } = setup({ ...timedDefinition(), enter: { targets: [] } })
    instance.executor.bind([])

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.6 })
    instance.executor.bind([['body', element]])

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
    instance.runtime.onUpdate = () => {
      if (!rebound && element.style.opacity === '0.5') {
        rebound = true
        instance.executor.bind([['body', replacement]])
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
    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    const first = nativeEffects(instance.executor)[0]
    first.pause()
    first.currentTime = 150
    const displayed = Number(getComputedStyle(element).scale)

    instance.runtime.updateParameters({ hover: false, press: false, size: 1.4 })
    const next = nativeEffects(instance.executor)[0]
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

    instance.runtime.updateParameters({ hover: false, press: true, size: 1 })
    const animation = nativeEffects(instance.executor)[0]
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

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    const animation = nativeEffects(instance.executor)[0]

    expect(animation.effect?.getTiming().easing).toContain('linear(')

    animation.finish()
    await animation.finished
  })

  it('settles zero-duration updates without creating effects', () => {
    const { instance, element } = setup(timedDefinition(0))

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(element.style.scale).toBe('1.4')
    expect(nativeEffects(instance.executor)).toEqual([])
  })

  it('skips animation while reduced motion is enabled', async () => {
    await setReducedMotion(true)

    try {
      const { instance, element } = setup(timedDefinition())
      instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

      expect(element.style.scale).toBe('1.4')
      expect(nativeEffects(instance.executor)).toEqual([])
    } finally {
      await setReducedMotion(false)
    }
  })

  it('keeps the resolved destination after external animation cancellation', async () => {
    const { instance, element, errors } = setup(timedDefinition())
    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    const animation = nativeEffects(instance.executor)[0]

    animation.cancel()
    await Promise.resolve()
    await Promise.resolve()

    expect(element.style.scale).toBe('1.4')
    expect(nativeEffects(instance.executor)).toEqual([])
    expect(errors[0].code).toBe('runtime.animation')
  })

  it('does not apply a stale completion after a newer reactive update', async () => {
    const { instance, element } = setup(timedDefinition())
    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    nativeEffects(instance.executor)[0].finish()

    instance.runtime.updateParameters({ hover: false, press: false, size: 1.4 })
    await Promise.resolve()

    expect(element.style.scale).toBe('1')
    expect(nativeEffects(instance.executor)).toHaveLength(1)
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

    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })

    expect(nativeEffects(instance.executor)).toEqual([])
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
    instance.runtime.updateParameters({ hover: false, press: false, size: 0.5 })
    const opacity = nativeEffects(instance.executor)[0]
    opacity.pause()
    opacity.currentTime = 100

    instance.runtime.updateParameters({ hover: true, press: false, size: 0.5 })

    expect(nativeEffects(instance.executor)).toContain(opacity)
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
    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })
    const opening = nativeEffects(instance.executor)[0]
    opening.pause()
    opening.currentTime = 0

    instance.runtime.updateParameters({ hover: false, press: false, size: 1 })
    const closing = nativeEffects(instance.executor)[0]
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
    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })
    const animation = nativeEffects(instance.executor)[0]

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
    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })
    const opening = nativeEffects(instance.executor)[0]
    opening.pause()
    opening.currentTime = 100

    expect(opening.effect?.getTiming().duration).toBe(225)
    const effect = opening.effect

    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

    expect(effect.getKeyframes().some((frame) => frame.scale === '1.2')).toBe(true)

    instance.runtime.updateParameters({ hover: false, press: false, size: 1 })
    const closing = nativeEffects(instance.executor)[0]

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

    instance.runtime.dispose()

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

    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })

    expect(element.style.opacity).toBe('1')
    expect(errors).toEqual([])
  })
})

function keyframeEffect(animation: Animation): KeyframeEffect {
  if (!(animation.effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

  return animation.effect
}

/** Inspect only registry ownership; playback and binding remain driven through public APIs. */
function registeredReceiverElements(instance: RuntimeAssembly): HTMLElement[] {
  const executor: unknown = Reflect.get(instance, 'executor')

  if (
    typeof executor !== 'object' ||
    executor === null ||
    !('receivers' in executor) ||
    !(executor.receivers instanceof Map)
  )
    throw new Error('Expected executor receiver registry')

  return Array.from(executor.receivers.values(), (receiver: unknown) => {
    if (
      typeof receiver !== 'object' ||
      receiver === null ||
      !('element' in receiver) ||
      !(receiver.element instanceof HTMLElement)
    )
      throw new Error('Expected registered receiving element')

    return receiver.element
  })
}

function start(phase: 'enter' | 'leave', instance: RuntimeAssembly, element: HTMLElement) {
  const work = capturePresence(instance, phase, ['body'])
  const session = new PresenceOperation(work, phase)
  session.initialize()
  session.initialize()
  session.play()

  for (const animation of element.getAnimations()) {
    animation.pause()
    animation.currentTime = 0
  }

  cleanup.push(() => session.cancel('owner-teardown'))

  return session
}

describe('layer lifecycle composition', () => {
  const lifecycle = {
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
  } satisfies import('../model/definition.ts').Transition

  it('retargets enter with ordinary timing and waits for replacement effects', async () => {
    const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
    const session = start('enter', instance, element)
    const effect = element.getAnimations()[0]

    expect(keyframeEffect(effect).getTiming().duration).toBe(1000)

    instance.runtime.updateParameters({ hover: true, press: true, size: 1.4 })

    const replacement = element.getAnimations()[0]

    replacement.pause()
    replacement.currentTime = 0

    expect(replacement).not.toBe(effect)
    expect(getComputedStyle(element).scale).toBe('0.5')
    expect(element.style.opacity).toBe('0.5')

    if (!(replacement.effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

    expect(replacement.effect.getKeyframes().at(-1)?.scale).toBe('0.9')
    expect(replacement.effect.getTiming().duration).toBe(300)

    await Promise.resolve()

    expect(session.isFinished).toBe(false)

    replacement.finish()

    expect(await session.finished).toBe('completed')

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
    const { instance, element, errors } = setup(source, {
      hover: false,
      press: true,
      size: 1,
    })
    const enter = start('enter', instance, element)
    const leave = start('leave', instance, element)
    const effects = element.getAnimations()

    expect(effects).toHaveLength(2)

    effects[1].currentTime = 500
    instance.runtime.updateParameters({ hover: false, press: false, size: 1 })

    expect(element.style.scale).toBe('')

    enter.cancel('superseded')

    // Explicit cancellation restores ownership synchronously before Promise callbacks.
    expect(enter.isFinished).toBe(true)
    expect(element.style.scale).toBe('')
    expect(element.style.opacity).toBe('0')
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
        instance.inspection.previewComposition(
          instance.runtime.composition,
          instance.runtime.composition,
        )
        instance.executor.endCompositionPreview()
      } else {
        instance.runtime.replaceDefinition(source)
      }

      expect(session.isFinished).toBe(true)

      element.style.scale = '1.7'

      await session.finished

      expect(element.style.scale).toBe('1.7')
    },
  )

  it('does not register an already finished lifecycle session for later restoration', async () => {
    const { instance, element } = setup(timedDefinition())
    const session = new PresenceOperation(capturePresence(instance, 'enter', []), 'enter')
    session.cancel('superseded')

    session.initialize()
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

      instance.runtime.updateParameters({ hover: false, press: false, size: 1 })

      expect(element.style.scale).toBe('')

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
    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    const session = start('enter', instance, element)
    const other = document.createElement('div')
    document.body.append(other)
    cleanup.push(() => other.remove())

    instance.executor.bind([
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

  async function completionWritesForRepeatedCapture(count: number) {
    const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
    const captures = capturePresence(instance, 'enter', ['body'])
    const session = new PresenceOperation(
      Array.from({ length: count }, () => captures).flat(),
      'enter',
    )

    cleanup.push(() => session.cancel('owner-teardown'))
    session.initialize()
    session.play()

    const writes = vi.spyOn(element.style, 'setProperty')

    for (const animation of element.getAnimations()) animation.finish()

    await session.finished

    expect(element.style.scale).toBe('1')

    const countWrites = writes.mock.calls.length

    writes.mockRestore()

    return countWrites
  }

  it('does not repeat completion writes when a capture joins the same boundary repeatedly', async () => {
    const single = await completionWritesForRepeatedCapture(1)
    const repeated = await completionWritesForRepeatedCapture(5)

    expect(repeated).toBe(single)
  })

  it.each([false, true])(
    'settles boundaries without disturbing unfinished enters (together=%s)',
    async (together) => {
      const { instance, element } = setup({ ...timedDefinition(), enter: lifecycle })
      const other = document.createElement('div')
      document.body.append(other)
      cleanup.push(() => other.remove())
      instance.executor.bind([
        ['body', element],
        ['body', other],
      ])

      const first = new PresenceOperation(
        capturePresence(instance, 'enter', ['body'], { element: element }),
        'enter',
      )
      const second = new PresenceOperation(
        capturePresence(instance, 'enter', ['body'], { element: other }),
        'enter',
      )

      for (const session of [first, second]) {
        session.initialize()
        session.initialize()
        session.play()

        cleanup.push(() => session.cancel('owner-teardown'))
      }

      for (const target of [element, other]) {
        for (const animation of target.getAnimations()) {
          animation.pause()
          animation.currentTime = 0
        }
      }

      instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

      for (const target of [element, other]) {
        for (const animation of target.getAnimations()) {
          animation.pause()
          animation.currentTime = 0
        }
      }

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

  it('reevaluates an active leave while unrelated declarations follow ordinary updates', async () => {
    const source: Definition = {
      ...definition,
      leave: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
                keyframes: [{ offset: 1, value: { kind: 'template', parts: [ref('size')] } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)
    const session = start('leave', instance, element)
    const initial = element.getAnimations()[0]

    instance.runtime.updateParameters({ hover: true, press: true, size: 1.7 })

    const replacement = element.getAnimations()[0]

    replacement.pause()
    replacement.currentTime = 0

    expect(replacement).not.toBe(initial)
    expect(element.style.opacity).toBe('0.5')
    expect(keyframeEffect(replacement).getKeyframes().at(-1)?.scale).toBe('1.7')

    await Promise.resolve()

    expect(session.isFinished).toBe(false)

    replacement.finish()

    expect(await session.finished).toBe('completed')
    expect(errors).toEqual([])
  })

  it.each(['dispose', 'replace'] as const)(
    'starts captured leave with the final original environment after %s',
    async (operation) => {
      const source: Definition = {
        ...definition,
        leave: {
          timing: lifecycle.timing,
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  keyframes: [{ offset: 1, value: { kind: 'template', parts: [ref('size')] } }],
                },
              ],
            },
          ],
        },
      }
      const { instance, element, errors } = setup(source)
      const work = capturePresence(instance, 'leave', ['body'])

      instance.runtime.updateParameters({ hover: false, press: false, size: 1.7 })

      if (operation === 'dispose') {
        instance.runtime.dispose()
        element.remove()
      } else {
        instance.runtime.replaceDefinition({ ...source, leave: undefined })
      }

      const session = new PresenceOperation(work, 'leave')

      cleanup.push(() => session.cancel('owner-teardown'))
      session.initialize()
      session.play()

      const animation = nativeEffects(instance.executor)[0]

      expect(keyframeEffect(animation).getKeyframes().at(-1)?.scale).toBe('1.7')

      animation.finish()

      expect(await session.finished).toBe('completed')
      expect(errors).toEqual([])
    },
  )

  it('distinguishes authored spring endpoints from ordinary completion values', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
          ],
        },
      ],
      enter: {
        timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  { offset: 0, value: { kind: 'literal', value: '0' } },
                  { offset: 1, value: { kind: 'literal', value: '0.6' } },
                ],
              },
            ],
          },
        ],
      },
    }
    const { instance, element } = setup(source)
    const session = start('enter', instance, element)
    const animation = element.getAnimations()[0]
    const frames = keyframeEffect(animation).getKeyframes()

    expect(frames.length).toBeGreaterThan(2)
    expect(frames[0].opacity).toBe('0')
    expect(frames.at(-1)?.opacity).toBe('0.6')

    animation.finish()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
  })

  it.each([false, true])(
    'retargets relative leave endpoints without input notifications (disposed=%s)',
    async (disposed) => {
      const source: Definition = {
        ...definition,
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'body',
                properties: [{ name: 'translate', value: { kind: 'literal', value: '0px' } }],
              },
            ],
          },
        ],
        leave: {
          timing: { kind: 'spring-duration', durationMs: 1000, bounce: 0.1 },
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'translate',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '100%' } }],
                },
              ],
            },
          ],
        },
      }
      const { instance, element, errors } = setup(source)

      element.style.width = '100px'

      const work = capturePresence(instance, 'leave', ['body'])
      const session = new PresenceOperation(work, 'leave')

      cleanup.push(() => session.cancel('owner-teardown'))
      session.initialize()
      session.play()

      const initial = element.getAnimations()[0]

      await initial.ready

      initial.currentTime = 50

      if (disposed) instance.runtime.dispose()

      element.style.width = '200px'

      await expect.poll(() => element.getAnimations()[0]).not.toBe(initial)

      const replacement = element.getAnimations()[0]

      expect(keyframeEffect(replacement).getKeyframes().at(-1)?.translate).toBe('200px')
      expect(session.isFinished).toBe(false)

      replacement.finish()

      expect(await session.finished).toBe('completed')
      expect(errors).toEqual([])
    },
  )

  it('relinquishes only the canonical enter component changed by an ordinary declaration', async () => {
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
                  name: 'inset-inline',
                  value: { kind: 'literal', value: '20px 40px' },
                  timing: { kind: 'tween', durationMs: 300, easing: 'linear' },
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
                  name: 'left',
                  value: { kind: 'literal', value: '60px' },
                  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                },
              ],
            },
          ],
        },
      ],
      enter: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'inset-inline',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px 0px' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)
    const session = start('enter', instance, element)
    const right = element
      .getAnimations()
      .find((animation) => keyframeEffect(animation).getKeyframes()[0]['right'] !== undefined)

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.1 })

    const left = element
      .getAnimations()
      .find((animation) => keyframeEffect(animation).getKeyframes()[0]['left'] !== undefined)!

    if (!left || !right) throw new Error('Expected physical inset effects')

    expect(element.getAnimations()).toContain(right)
    expect(keyframeEffect(left).getKeyframes().at(-1)?.left).toBe('60px')
    expect(left.effect?.getTiming().duration).toBe(200)

    left.finish()

    await Promise.resolve()

    expect(session.isFinished).toBe(false)

    right.finish()

    expect(await session.finished).toBe('completed')
    expect(getComputedStyle(element).left).toBe('60px')
    expect(getComputedStyle(element).right).toBe('40px')
    expect(errors).toEqual([])
  })

  it('keeps receiver-specific enter components when repeated targets use ltr/rtl directions', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'inset-inline', value: { kind: 'literal', value: '20px 40px' } },
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
                  name: 'inset-inline-start',
                  value: { kind: 'literal', value: '60px' },
                  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
                },
              ],
            },
          ],
        },
      ],
      enter: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'inset-inline',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px 0px' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)
    const second = document.createElement('div')

    element.style.cssText = 'position: relative; direction: ltr'
    second.style.cssText = 'position: relative; direction: rtl'
    document.body.append(second)
    cleanup.push(() => second.remove())
    instance.executor.bind([
      ['body', element],
      ['body', second],
    ])

    const session = new PresenceOperation(
      [element, second].flatMap((receiver) =>
        capturePresence(instance, 'enter', ['body'], { element: receiver }),
      ),
      'enter',
    )

    cleanup.push(() => session.cancel('owner-teardown'))
    session.play()

    const receivers = [
      { element, unchanged: 'right' },
      { element: second, unchanged: 'left' },
    ]
    const retained = receivers.map(({ element: receiver, unchanged }) => {
      for (const animation of receiver.getAnimations()) {
        animation.pause()
        animation.currentTime = 500
      }

      const animation = receiver
        .getAnimations()
        .find((candidate) => keyframeEffect(candidate).getKeyframes()[0][unchanged] !== undefined)

      if (!animation) throw new Error(`Expected enter effect for ${unchanged}`)

      return {
        receiver,
        unchanged,
        animation,
        value: getComputedStyle(receiver).getPropertyValue(unchanged),
      }
    })

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.1 })

    for (const { receiver, unchanged, animation, value } of retained) {
      expect(receiver.getAnimations()).toContain(animation)
      expect(getComputedStyle(receiver).getPropertyValue(unchanged)).toBe(value)

      for (const changed of receiver.getAnimations()) {
        if (changed !== animation) changed.finish()
      }
    }

    await Promise.resolve()

    expect(session.isFinished).toBe(false)

    retained[0].animation.finish()

    await Promise.resolve()

    expect(session.isFinished).toBe(false)

    retained[1].animation.finish()

    expect(await session.finished).toBe('completed')
    expect(getComputedStyle(element).right).toBe('40px')
    expect(getComputedStyle(second).getPropertyValue(receivers[1].unchanged)).toBe('40px')
    expect(errors).toEqual([])
  })

  it.each([false, true])(
    'initializes the latest enter expression before paint while retaining an explicit rebase (%s)',
    async (rebased) => {
      const source: Definition = {
        ...definition,
        enter: {
          timing: lifecycle.timing,
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  keyframes: [{ offset: 0, value: { kind: 'template', parts: [ref('size')] } }],
                },
              ],
            },
          ],
        },
      }
      const { instance, element } = setup(source)
      if (rebased) element.style.scale = '0.7'

      const work = capturePresence(instance, 'enter', ['body'], { interrupted: rebased })

      instance.runtime.updateParameters({ hover: false, press: false, size: 0.3 })

      const session = new PresenceOperation(work, 'enter')

      cleanup.push(() => session.cancel('owner-teardown'))
      session.initialize()

      expect(element.style.scale).toBe(rebased ? '0.7' : '0.3')

      session.play()

      const animation = element.getAnimations()[0]

      expect(keyframeEffect(animation).getKeyframes()[0].scale).toBe(rebased ? '0.7' : '0.3')

      animation.finish()

      expect(await session.finished).toBe('completed')
    },
  )

  it.each(['resize', 'native completion'] as const)(
    'retargets a live relative leave during manual preview after %s',
    async (trigger) => {
      const base = timedDefinition(1000)
      const source: Definition = {
        ...base,
        layers: base.layers.map((layer) =>
          layer.name === 'base'
            ? {
                ...layer,
                targets: layer.targets.map((target) => ({
                  ...target,
                  properties: [
                    ...target.properties,
                    {
                      name: 'translate',
                      value: { kind: 'literal', value: '0px' },
                      timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
                    },
                  ],
                })),
              }
            : {
                ...layer,
                targets: layer.targets.map((target) => ({
                  ...target,
                  properties: [
                    ...target.properties,
                    { name: 'translate', value: { kind: 'literal', value: '40px' } },
                  ],
                })),
              },
        ),
        leave: {
          timing: { kind: 'spring-duration', durationMs: 1000, bounce: 0.1 },
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'translate',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '100%' } }],
                },
              ],
            },
          ],
        },
      }
      const { instance, element, errors } = setup(source)

      element.style.width = '100px'

      const session = start('leave', instance, element)
      const leave = element.getAnimations()[0]

      await leave.ready

      leave.play()
      instance.inspection.previewComposition(instance.runtime.composition, {
        layers: { base: true, hover: true, press: false },
        states: {},
      })

      const previews = nativeEffects(instance.executor)

      await Promise.all(previews.map((animation) => animation.ready))

      for (const animation of previews) animation.currentTime = 500

      const displayed = getComputedStyle(element).scale
      const translated = getComputedStyle(element).translate
      const inline = element.style.cssText

      element.style.width = '200px'

      if (trigger === 'native completion') leave.finish()

      await expect
        .poll(
          () =>
            keyframeEffect(
              element.getAnimations().filter((animation) => !previews.includes(animation))[0],
            )
              .getKeyframes()
              .at(-1)?.translate,
        )
        .toBe('200px')

      const replacement = element.getAnimations().find((animation) => !previews.includes(animation))

      if (!replacement) throw new Error('Expected retargeted live leave')

      expect(session.isFinished).toBe(false)
      expect(element.style.cssText).toBe(inline.replace('width: 100px', 'width: 200px'))
      expect(nativeEffects(instance.executor)).toEqual(previews)
      expect(getComputedStyle(element).scale).toBe(displayed)
      expect(getComputedStyle(element).translate).toBe(translated)

      replacement.finish()

      await expect.poll(() => session.isFinished, { timeout: 300 }).toBe(true)

      expect(await session.finished).toBe('completed')
      expect(nativeEffects(instance.executor)).toEqual(previews)

      for (const animation of previews) {
        expect(animation.playState).toBe('paused')
        expect(animation.currentTime).toBe(500)

        animation.currentTime = 800
      }

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(Number(displayed))
      expect(parseFloat(getComputedStyle(element).translate)).toBeGreaterThan(
        parseFloat(translated),
      )

      for (const animation of previews) animation.currentTime = 200

      expect(Number(getComputedStyle(element).scale)).toBeLessThan(Number(displayed))
      expect(parseFloat(getComputedStyle(element).translate)).toBeLessThan(parseFloat(translated))
      expect(errors).toEqual([])
    },
  )

  it.each([
    'completion',
    'cancellation',
    'preview completion',
    'preview cancellation',
    'restoration failure',
  ] as const)(
    'retires a detached receiver after %s while retaining its current replacement',
    async (ending) => {
      const { instance, element } = setup({ ...timedDefinition(), leave: lifecycle })
      const report = vi.fn<(error: unknown) => void>()
      const session = new PresenceOperation(
        capturePresence(instance, 'leave', ['body']),
        'leave',
        report,
      )

      cleanup.push(() => session.cancel('owner-teardown'))
      session.play()

      const leave = element.getAnimations()[0]
      const replacement = document.createElement('div')

      leave.pause()

      document.body.append(replacement)
      cleanup.push(() => replacement.remove())
      instance.executor.bind([['body', replacement]])
      element.remove()

      // Public playback drives ownership; inspect the strong registry to prove retirement,
      // independently of garbage-collector timing or native animation retention.
      const registered = () => registeredReceiverElements(instance)

      expect(registered()).toEqual([element, replacement])
      expect(session.isFinished).toBe(false)

      if (ending.startsWith('preview'))
        instance.inspection.previewComposition(
          instance.runtime.composition,
          instance.runtime.composition,
        )

      const failure = new Error('restoration failed')
      const restore =
        ending === 'restoration failure'
          ? vi.spyOn(element.style, 'cssText', 'set').mockImplementationOnce(() => {
              throw failure
            })
          : undefined
      // Session completion must still release executor resources when restoration throws.
      try {
        if (ending.endsWith('completion')) leave.finish()
        else session.cancel('owner-teardown')

        await session.finished

        // Frozen effects still use the old receiver until preview itself ends.
        expect(registered()).toEqual(
          ending.startsWith('preview') ? [element, replacement] : [replacement],
        )

        if (ending.startsWith('preview')) instance.executor.endCompositionPreview()

        expect(registered()).toEqual([replacement])

        instance.executor.bind([['body', replacement]])

        expect(registered()).toEqual([replacement])
        expect(element.getAnimations()).toEqual([])
        expect(Reflect.get(instance, 'executor')).toEqual(
          expect.objectContaining({
            owned: expect.not.arrayContaining([expect.objectContaining({ element })]),
          }),
        )

        expect(report.mock.calls).toEqual(restore ? [[failure]] : [])
      } finally {
        restore?.mockRestore()
      }
    },
  )

  it('retains a settled receiver while a current physical alias still binds it', async () => {
    const { instance, element } = setup({ ...timedDefinition(), leave: lifecycle })
    const session = start('leave', instance, element)
    const leave = element.getAnimations()[0]
    const replacement = document.createElement('div')

    document.body.append(replacement)
    cleanup.push(() => replacement.remove())
    instance.executor.bind([
      ['body', replacement],
      ['alias', element],
    ])
    leave.finish()

    await session.finished

    expect(registeredReceiverElements(instance)).toEqual([element, replacement])

    instance.executor.bind([['body', replacement]])

    expect(registeredReceiverElements(instance)).toEqual([replacement])
  })

  it('retains a detached receiver until its last independent leave settles', async () => {
    const source: Definition = {
      ...timedDefinition(),
      leave: {
        ...lifecycle,
        targets: [
          {
            name: 'body',
            properties: [
              ...lifecycle.targets[0].properties,
              {
                name: 'opacity',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element } = setup(source)
    const sessions = ['scale', 'opacity'].map((property) => {
      const session = new PresenceOperation(
        capturePresence(instance, 'leave', ['body'], { properties: [property] }),
        'leave',
      )

      cleanup.push(() => session.cancel('owner-teardown'))
      session.play()

      return session
    })
    const [scale, opacity] = element.getAnimations()
    const replacement = document.createElement('div')

    document.body.append(replacement)
    cleanup.push(() => replacement.remove())
    instance.executor.bind([['body', replacement]])
    element.remove()
    scale.finish()

    await sessions[0].finished

    expect(sessions[1].isFinished).toBe(false)
    expect(registeredReceiverElements(instance)).toEqual([element, replacement])
    expect(opacity.playState).not.toBe('idle')

    opacity.finish()

    await sessions[1].finished

    expect(registeredReceiverElements(instance)).toEqual([replacement])
  })

  it('retires an element-specific capture without requiring a later binding change', async () => {
    const { instance, element } = setup({ ...timedDefinition(), leave: lifecycle })
    const captured = document.createElement('div')

    document.body.append(captured)
    cleanup.push(() => captured.remove())

    const session = new PresenceOperation(
      capturePresence(instance, 'leave', ['body'], { element: captured }),
      'leave',
    )

    cleanup.push(() => session.cancel('owner-teardown'))
    session.play()

    const leave = captured.getAnimations()[0]

    expect(registeredReceiverElements(instance)).toEqual([element, captured])

    leave.finish()

    await session.finished

    expect(registeredReceiverElements(instance)).toEqual([element])
  })

  it('settles a live leave on reduced motion while preserving a seekable manual preview', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const reduced = vi.spyOn(media, 'matches', 'get').mockReturnValue(false)

    try {
      const source: Definition = {
        ...timedDefinition(1000),
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
      const { instance, element, errors } = setup(source)
      const session = start('leave', instance, element)
      const leave = element.getAnimations()[0]

      instance.inspection.previewComposition(instance.runtime.composition, {
        layers: { base: true, hover: true, press: false },
        states: {},
      })

      const previews = nativeEffects(instance.executor)

      expect(previews.length).toBeGreaterThan(0)
      expect(previews).not.toContain(leave)

      await Promise.all(previews.map((animation) => animation.ready))

      for (const animation of previews) animation.currentTime = 500

      const displayed = getComputedStyle(element).scale

      reduced.mockReturnValue(true)
      media.dispatchEvent(new Event('change'))

      await expect.poll(() => session.isFinished, { timeout: 300 }).toBe(true)

      expect(await session.finished).toBe('completed')
      expect(element.getAnimations()).not.toContain(leave)
      expect(nativeEffects(instance.executor)).toEqual(previews)
      expect(getComputedStyle(element).scale).toBe(displayed)

      for (const animation of previews) {
        expect(animation.playState).toBe('paused')
        expect(animation.currentTime).toBe(500)

        animation.currentTime = 800
      }

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(Number(displayed))

      for (const animation of previews) animation.currentTime = 200

      expect(Number(getComputedStyle(element).scale)).toBeLessThan(Number(displayed))

      instance.executor.endCompositionPreview()

      expect(element.getAnimations()).toEqual([])
      expect(element.style.scale).toBe('1')
      expect(errors).toEqual([])
    } finally {
      reduced.mockRestore()
      factory.mockRestore()
    }
  })

  it('fails and releases a presence group when completion-time reference observation throws', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [{ name: 'translate', value: { kind: 'literal', value: '0px' } }],
            },
          ],
        },
      ],
      leave: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'translate',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '100%' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element } = setup(source)

    element.style.width = '100px'

    const failures: unknown[] = []
    const session = new PresenceOperation(
      capturePresence(instance, 'leave', ['body']),
      'leave',
      (error) => failures.push(error),
    )

    cleanup.push(() => session.cancel('owner-teardown'))
    session.initialize()
    session.play()

    const animation = element.getAnimations()[0]
    const failure = new Error('reference observation failed')
    const observe = vi.spyOn(window, 'getComputedStyle').mockImplementationOnce(() => {
      throw failure
    })

    try {
      animation.finish()

      expect(await session.finished).toBe('failed')
      expect(element.getAnimations()).toEqual([])
      expect(failures).toEqual([failure])
    } finally {
      observe.mockRestore()
    }
  })

  it('keeps enter property, target, and phase timing independent of an already accepted ordinary transition', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'opacity', value: { kind: 'literal', value: '1' } },
                { name: 'scale', value: { kind: 'literal', value: '1' } },
                { name: 'width', value: { kind: 'literal', value: '20px' } },
              ],
            },
          ],
          initialState: 'off',
          states: [
            { name: 'off', targets: [] },
            { name: 'on', targets: [] },
          ],
          transitions: [
            {
              from: 'off',
              to: 'on',
              when: ref('hover'),
              transition: {
                timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
                targets: [],
              },
            },
          ],
        },
      ],
      enter: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            timing: { kind: 'tween', durationMs: 700, easing: 'linear' },
            timingProperties: ['opacity', 'scale'],
            properties: [
              {
                name: 'opacity',
                timing: { kind: 'tween', durationMs: 300, easing: 'linear' },
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }],
              },
              {
                name: 'scale',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0.5' } }],
              },
              {
                name: 'width',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)

    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })

    for (const animation of element.getAnimations()) animation.finish()

    await Promise.resolve()

    const session = start('enter', instance, element)
    const effects = element.getAnimations().map((animation) => keyframeEffect(animation))

    expect(effects.map((effect) => effect.getTiming().duration)).toEqual([300, 700, 1000])
    expect(
      effects.map(
        (effect) =>
          effect.getKeyframes()[0].opacity ??
          effect.getKeyframes()[0].scale ??
          effect.getKeyframes()[0].width,
      ),
    ).toEqual(['0', '0.5', '0px'])

    for (const animation of element.getAnimations()) animation.finish()

    expect(await session.finished).toBe('completed')
    expect(errors).toEqual([])
  })

  it.each(['edit', 'remove'] as const)(
    'releases retired detached fields before reacquiring their external %s',
    async (change) => {
      const element = document.createElement('div')

      element.style.cssText = 'position:relative;inset:11px !important;scale:.8;--external:7px 8px;'
      document.body.append(element)

      const source: Definition = {
        name: 'detached-ownership',
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'body',
                properties: [
                  { name: 'inset', value: { kind: 'literal', value: '10px' } },
                  { name: 'scale', value: { kind: 'literal', value: '1' } },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: lifecycle.timing,
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'inset',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '0px' } }],
                },
                {
                  name: 'scale',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '0.2' } }],
                },
              ],
            },
          ],
        },
      }
      const instance = assembleRuntime(source)

      instance.executor.bind([['body', element]])

      const inset = capturePresence(instance, 'leave', ['body'], { properties: ['inset'] })
      const scale = new PresenceOperation(
        capturePresence(instance, 'leave', ['body'], { properties: ['scale'] }),
        'leave',
      )
      const first = new PresenceOperation(inset, 'leave')
      let next: PresenceOperation | undefined

      try {
        for (const session of [first, scale]) {
          session.initialize()
          session.play()
        }

        instance.runtime.dispose()

        for (const animation of element.getAnimations()) {
          animation.pause()

          if (keyframeEffect(animation).getKeyframes()[0].scale === undefined) animation.finish()
        }

        expect(await first.finished).toBe('completed')
        expect(scale.isFinished).toBe(false)

        if (change === 'edit') element.style.setProperty('inset', 'var(--external)', 'important')
        else element.style.removeProperty('inset')

        next = new PresenceOperation(inset, 'leave')
        next.initialize()
        next.play()

        for (const animation of element.getAnimations()) {
          if (keyframeEffect(animation).getKeyframes()[0].scale === undefined) animation.finish()
        }

        expect(await next.finished).toBe('completed')
        expect(element.style.getPropertyValue('inset')).toBe(
          change === 'edit' ? 'var(--external)' : '',
        )
        expect(element.style.getPropertyPriority('inset')).toBe(
          change === 'edit' ? 'important' : '',
        )
        expect(scale.isFinished).toBe(false)

        scale.cancel('owner-teardown')

        expect(element.style.getPropertyValue('inset')).toBe(
          change === 'edit' ? 'var(--external)' : '',
        )
      } finally {
        first.cancel('owner-teardown')
        next?.cancel('owner-teardown')
        scale.cancel('owner-teardown')
        instance.runtime.dispose()
        element.remove()
      }
    },
  )

  it('preserves enter while only another logical target changes and completes independently', async () => {
    const source: Definition = {
      ...timedDefinition(),
      enter: lifecycle,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [{ name: 'scale', value: { kind: 'literal', value: '1' } }],
            },
            {
              name: 'other',
              properties: [
                {
                  name: 'opacity',
                  value: { kind: 'literal', value: '1' },
                  timing: lifecycle.timing,
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
              name: 'other',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
            },
          ],
        },
      ],
    }
    const { instance, element, errors } = setup(source)
    const other = document.createElement('div')

    document.body.append(other)
    cleanup.push(() => other.remove())
    instance.executor.bind([
      ['body', element],
      ['other', other],
    ])

    const session = start('enter', instance, element)
    const enter = element.getAnimations()[0]

    instance.runtime.updateParameters({ hover: true, press: false, size: 1 })

    const ordinary = other.getAnimations()[0]

    ordinary.pause()
    ordinary.currentTime = 0

    expect(element.getAnimations()).toContain(enter)

    enter.finish()

    expect(await session.finished).toBe('completed')
    expect(other.getAnimations()).toContain(ordinary)
    expect(errors).toEqual([])
  })

  it('retains a real captured operation across a binding replacement', async () => {
    const source = {
      ...timedDefinition(),
      enter: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
                keyframes: [{ offset: 0, value: { kind: 'literal' as const, value: '0.5' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)
    const session = new PresenceOperation(capturePresence(instance, 'enter', ['body']), 'enter')

    cleanup.push(() => session.cancel('owner-teardown'))
    session.initialize()
    session.play()
    session.initialize()

    const animation = element.getAnimations()[0]

    animation.pause()
    animation.currentTime = 0

    const other = document.createElement('div')

    document.body.append(other)
    cleanup.push(() => other.remove())

    instance.executor.bind([
      ['body', element],
      ['extra', other],
    ])

    expect(getComputedStyle(element).scale).toBe('0.5')
    expect(element.getAnimations()).toContain(animation)

    animation.finish()

    expect(await session.finished).toBe('completed')
    expect(errors).toEqual([])
  })

  it('observes repeated scoped declarations once per phase as receiver count grows', () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'inset-inline', value: { kind: 'literal', value: '20px 40px' } },
              ],
            },
          ],
        },
      ],
      enter: {
        timing: lifecycle.timing,
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'inset-inline',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }],
              },
            ],
          },
        ],
      },
    }

    const readsFor = (count: number) => {
      const { instance, element } = setup(source)
      const receivers = [
        element,
        ...Array.from({ length: count - 1 }, () => document.createElement('div')),
      ]

      for (const receiver of receivers.slice(1)) {
        document.body.append(receiver)
        cleanup.push(() => receiver.remove())
      }

      instance.executor.bind(receivers.map((receiver) => ['body', receiver] as const))

      const session = new PresenceOperation(
        receivers.flatMap((receiver) =>
          capturePresence(instance, 'enter', ['body'], { element: receiver }),
        ),
        'enter',
      )

      cleanup.push(() => session.cancel('owner-teardown'))
      session.initialize()
      session.play()

      const original = window.getComputedStyle
      const observed = new Set<Element>(receivers)
      let reads = 0
      const observe = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation((receiver, pseudo) => {
          if (observed.has(receiver)) reads++

          return original.call(window, receiver, pseudo)
        })

      try {
        instance.runtime.updateParameters({ hover: false, press: false, size: 2 })

        expect(session.isFinished).toBe(false)

        return reads
      } finally {
        observe.mockRestore()
      }
    }

    const small = readsFor(2)
    const large = readsFor(4)

    expect(small).toBeGreaterThan(0)
    expect(large).toBe(small * 2)
  })

  it('replaces obsolete canonical components when relative dimensions and writing context change', async () => {
    const source: Definition = {
      ...definition,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [{ name: 'inset-inline', value: { kind: 'literal', value: '0px' } }],
            },
          ],
        },
      ],
      leave: {
        timing: { kind: 'spring-duration', durationMs: 1000, bounce: 0.1 },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'inset-inline',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '50% 70%' } }],
              },
            ],
          },
        ],
      },
    }
    const { instance, element, errors } = setup(source)
    const container = document.createElement('div')

    container.style.cssText = 'position:relative;width:400px;height:300px'
    document.body.append(container)
    container.append(element)
    cleanup.push(() => container.remove())
    element.style.cssText += ';position:absolute;width:100px;height:100px'

    const session = new PresenceOperation(capturePresence(instance, 'leave', ['body']), 'leave')

    cleanup.push(() => session.cancel('owner-teardown'))
    session.initialize()
    session.play()

    const original = [...nativeEffects(instance.executor)]
    const properties = () =>
      nativeEffects(instance.executor)
        .flatMap((animation) =>
          Object.keys(keyframeEffect(animation).getKeyframes()[0]).filter((property) =>
            ['left', 'right', 'top', 'bottom'].includes(property),
          ),
        )
        .toSorted()

    expect(properties()).toEqual(['left', 'right'])

    container.style.width = '500px'

    await expect
      .poll(() => ({
        properties: properties(),
        replaced: !nativeEffects(instance.executor).some((animation) =>
          original.includes(animation),
        ),
      }))
      .toEqual({ properties: ['left', 'right'], replaced: true })

    expect(session.isFinished).toBe(false)

    const beforeContext = [...nativeEffects(instance.executor)]

    element.style.writingMode = 'vertical-rl'
    container.style.width = '600px'

    await expect.poll(properties).toEqual(['bottom', 'top'])

    expect(
      [...original, ...beforeContext].every((animation) => animation.playState === 'idle'),
    ).toBe(true)
    expect(session.isFinished).toBe(false)

    for (const animation of nativeEffects(instance.executor)) animation.finish()

    expect(await session.finished).toBe('completed')
    expect(errors).toEqual([])
  })

  it.each([
    {
      change: 'hidden lower declaration',
      hover: true,
      size: 30,
      leftDuring: '0px',
      leftAfter: '60px',
      right: '50px',
      retained: true,
    },
    {
      change: 'winning declaration removal',
      hover: false,
      size: 20,
      leftDuring: '20px',
      leftAfter: '20px',
      right: '40px',
      retained: false,
    },
  ])(
    'uses effective ordinary ownership for $change during enter',
    async ({ hover, size, leftDuring, leftAfter, right, retained }) => {
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
                    name: 'inset-inline',
                    value: {
                      kind: 'template',
                      parts: [
                        ref('size'),
                        'px ',
                        {
                          kind: 'binary',
                          operator: '+',
                          left: ref('size'),
                          right: { kind: 'number', value: 20 },
                        },
                        'px',
                      ],
                    },
                  },
                  { name: 'opacity', value: { kind: 'literal', value: '1' } },
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
                properties: [{ name: 'left', value: { kind: 'literal', value: '60px' } }],
              },
            ],
          },
        ],
        enter: {
          timing: lifecycle.timing,
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'left',
                  keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }],
                },
                {
                  name: 'opacity',
                  keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }],
                },
              ],
            },
          ],
        },
      }
      const { instance, element, errors } = setup(source, { hover: true, press: false, size: 20 })

      element.style.position = 'relative'

      const session = start('enter', instance, element)
      const left = element
        .getAnimations()
        .find((animation) => keyframeEffect(animation).getKeyframes()[0].left !== undefined)
      const opacity = element
        .getAnimations()
        .find((animation) => keyframeEffect(animation).getKeyframes()[0].opacity !== undefined)

      if (!left || !opacity) throw new Error('Expected independent enter tracks')

      instance.runtime.updateParameters({ hover, press: false, size })

      await Promise.resolve()

      expect(element.getAnimations().includes(left)).toBe(retained)
      expect(element.getAnimations()).toContain(opacity)
      expect(getComputedStyle(element).left).toBe(leftDuring)
      expect(getComputedStyle(element).right).toBe(right)
      expect(session.isFinished).toBe(false)

      for (const animation of element.getAnimations()) animation.finish()

      expect(await session.finished).toBe('completed')
      expect(getComputedStyle(element).left).toBe(leftAfter)
      expect(getComputedStyle(element).right).toBe(right)
      expect(errors).toEqual([])
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

    instance.runtime.updateParameters({ hover: true, press: true, size: 1.4 })

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

    instance.inspection.previewComposition(from, to)
    const animation = nativeEffects(instance.executor)[0]
    await animation.ready
    animation.currentTime = 100

    expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(1)
    expect(instance.runtime.composition).toEqual(from)

    animation.currentTime = 200
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1.1)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)

    instance.executor.endCompositionPreview()

    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(element.style.scale).toBe('1')
    expect(errors).toEqual([])
  })

  it('isolates candidate definitions and restores the latest input update', () => {
    const first = setup(timedDefinition())
    const second = setup(timedDefinition())
    const original = first.instance.runtime.definition
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

    first.instance.inspection.previewComposition(from, to, [], candidate)

    expect(first.instance.runtime.definition).toBe(original)
    expect(nativeEffects(second.instance.executor)).toHaveLength(0)
    expect(second.element.style.scale).toBe('1')

    first.instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })
    first.instance.executor.endCompositionPreview()

    expect(first.instance.runtime.composition).toEqual(to)
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

    instance.inspection.previewComposition(off, on)
    expect(element.style.scale).toBe('1.1')

    instance.executor.endCompositionPreview()
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

    instance.inspection.previewComposition(done, idle)
    instance.executor.endCompositionPreview()
    instance.runtime.updateParameters({ hover: false, press: false, size: 1.1 })

    expect(instance.runtime.composition).toEqual(done)
  })

  it('releases preview effects on unmount and rejects further previews', () => {
    const { instance, element } = setup(timedDefinition())

    instance.inspection.previewComposition(from, to)
    instance.runtime.dispose()

    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(element.style.scale).toBe('')
    expect(() => instance.inspection.previewComposition(from, to)).toThrow('mounted layer instance')
  })

  it('keeps paused scrubbing available across reduced-motion changes', async () => {
    const { instance, element } = setup(timedDefinition(200))

    await setReducedMotion(true)

    try {
      instance.inspection.previewComposition(from, to)
      const animation = nativeEffects(instance.executor)[0]
      await animation.ready
      animation.currentTime = 100

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(1)
      expect(Number(getComputedStyle(element).scale)).toBeLessThan(1.1)

      await setReducedMotion(false)
      animation.currentTime = 0

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)
    } finally {
      instance.executor.endCompositionPreview()
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

    instance.inspection.previewComposition(from, to)
    const animation = nativeEffects(instance.executor)[0]
    await animation.ready
    animation.currentTime = 400

    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1.1)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(1)
  })

  it('ends previews when targets are removed', () => {
    const { instance, element } = setup(timedDefinition())

    instance.inspection.previewComposition(from, to)
    instance.executor.bind([])

    expect(element.style.scale).toBe('')
    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(() => instance.inspection.previewComposition(from, to)).toThrow('mounted layer instance')
  })

  it('ends previews when the definition is replaced', () => {
    const { instance, element } = setup(timedDefinition())

    instance.inspection.previewComposition(from, to)
    instance.runtime.replaceDefinition(definition)

    expect(element.style.scale).toBe('1')
    expect(nativeEffects(instance.executor)).toHaveLength(0)
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

    instance.inspection.previewComposition(composition, composition)
    const animation = nativeEffects(instance.executor)[0]
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

    instance.inspection.previewComposition(composition, composition, [
      { layer: 'machine', index: 0 },
    ])

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

    instance.inspection.previewComposition(before, after)

    expect(nativeEffects(instance.executor)).toHaveLength(1)

    instance.executor.endCompositionPreview()

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
      expect(() => instance.inspection.previewComposition(from, to)).toThrow(
        'Could not prepare composition preview',
      )
      expect(cancellations).toHaveLength(1)
      expect(cancellations[0]).toHaveBeenCalledExactlyOnceWith()
      expect(element.getAnimations()).toHaveLength(0)
      expect(nativeEffects(instance.executor)).toHaveLength(0)
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
      expect(() => instance.inspection.previewComposition(from, to)).toThrow(
        'Could not prepare composition preview',
      )
      expect(errors.at(-1)?.error).toMatchObject({ cause: original })
      expect(nativeEffects(instance.executor)).toHaveLength(0)
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

      instance.runtime.updateParameters({ amount: 1, count: 2 })
      const animation = nativeEffects(instance.executor)[0]
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

    instance.runtime.updateParameters({ amount: 0.75, count: 4, position: 'start' })

    expect(element.style.opacity).toBe('0.75')
    expect(element.style.getPropertyValue('--position')).toBe('start')

    for (const args of [
      { count: 0, position: 'end' },
      { count: 1, position: 'jump-none' },
      { count: 2, position: 'middle' },
    ]) {
      instance.runtime.updateParameters({ amount: 1, ...args })

      expect(errors.at(-1)?.code).toBe('runtime.expression')
      expect(element.style.opacity).toBe('0.75')
      expect(element.style.getPropertyValue('--position')).toBe('start')
    }

    expect(errors).toHaveLength(3)

    instance.runtime.replaceDefinition(structuredClone(source))

    expect(element.style.opacity).toBe('0.75')
    expect(element.style.getPropertyValue('--position')).toBe('start')

    instance.runtime.updateParameters({ amount: 0.5, count: 2, position: 'end' })

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

    instance.inspection.previewComposition(
      { layers: {}, states: { machine: 'idle' } },
      { layers: {}, states: { machine: 'active' } },
      [{ layer: 'machine', index: 0 }],
    )
    const animation = nativeEffects(instance.executor)[0]
    await animation.ready

    expect(animation.effect?.getTiming().duration).toBe(400)

    animation.currentTime = 0
    expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(0)

    animation.currentTime = 400
    expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(1)

    instance.executor.endCompositionPreview()
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
    instance.executor.bind([
      ['body', element],
      ['badge', badge],
    ])

    instance.inspection.previewLifecycle('leave', {
      layers: { base: true, hover: false, press: false },
      states: {},
    })

    await Promise.all(nativeEffects(instance.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 100

    expect(Number(getComputedStyle(badge).opacity)).toBeCloseTo(0.3)
    expect(Number(getComputedStyle(element).scale)).toBeCloseTo(0.5)

    instance.runtime.updateParameters({ hover: true, press: false, size: 1.4 })

    expect(nativeEffects(instance.executor)).toHaveLength(0)
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
      const original = instance.runtime.composition

      instance.inspection.previewLifecycle(phase, baseline)

      const animation = nativeEffects(instance.executor)[0]

      await animation.ready

      animation.currentTime = 100

      expect(Number(getComputedStyle(element).scale)).toBeGreaterThan(0)
      expect(Number(getComputedStyle(element).scale)).toBeLessThan(1.1)
      expect(instance.runtime.composition).toEqual(original)
      expect(element.isConnected).toBe(true)

      animation.currentTime = 200

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(phase === 'enter' ? 1.1 : 0)

      animation.currentTime = 0

      expect(Number(getComputedStyle(element).scale)).toBeCloseTo(phase === 'enter' ? 0 : 1.1)

      instance.executor.endCompositionPreview()

      expect(element.style.scale).toBe('1')
      expect(nativeEffects(instance.executor)).toHaveLength(0)
    },
  )
})
