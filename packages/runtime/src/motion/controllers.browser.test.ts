import { capturePresence } from '../__test__/helpers/presence.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Definition, Expression } from '../model/definition.ts'
import { PresenceOperation } from '../execution/presence-operation.ts'
import { LivaInstance, type RuntimeDiagnostic } from '../execution/instance.ts'
import { decodeProperty } from './property-codec.ts'
import { PropertyMotion, springMotion } from './property-motion.ts'

const reference = (...path: string[]): Expression => ({ kind: 'reference', path })
const instances: LivaInstance[] = []
const elements: HTMLElement[] = []

function definition(component: 'x' | 'y' = 'x'): Definition {
  return {
    name: 'controller',
    parameters: [
      { name: 'input', type: 'number' },
      { name: 'enabled', type: 'boolean' },
      { name: 'sensitivity', type: 'number' },
      { name: 'destination', type: 'number' },
    ],
    letBindings: [
      {
        name: 'movement',
        initializer: {
          kind: 'call',
          function: 'link',
          arguments: [
            { name: 'input', value: reference('input') },
            { name: 'sensitivity', value: reference('sensitivity') },
            { name: 'component', value: { kind: 'string', value: component } },
          ],
        },
      },
    ],
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'translate',
                value: {
                  kind: 'template',
                  parts: [reference('destination'), 'px 20px 3px'],
                },
                timing: { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
              },
              {
                name: '--observed',
                value: {
                  kind: 'template',
                  parts: [reference('movement', 'value', component)],
                },
              },
              {
                name: '--velocity',
                value: {
                  kind: 'template',
                  parts: [reference('movement', 'velocity', component)],
                },
              },
            ],
          },
        ],
      },
      {
        name: 'active',
        when: reference('enabled'),
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
}

function setup(
  component: 'x' | 'y' = 'x',
  transform: (value: Definition) => Definition = (value) => value,
  extraInputs: Readonly<Record<string, number | boolean>> = {},
) {
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:200px;height:80px;translate:100px 20px 3px;'
  document.body.append(element)
  elements.push(element)
  const errors: RuntimeDiagnostic[] = []
  const inputs = { input: 0, enabled: false, sensitivity: 1, destination: 100, ...extraInputs }
  const instance = new LivaInstance(transform(definition(component)), inputs, (error) =>
    errors.push(error),
  )
  instances.push(instance)
  instance.bind([['self', element]])

  return { element, instance, inputs, errors }
}

/** Uses one long phase so inspection and preview can observe it before completion. */
function withTranslatePresence(value: Definition, phase: 'enter' | 'leave'): Definition {
  return {
    ...value,
    [phase]: {
      timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
      targets: [
        {
          name: 'self',
          properties: [
            {
              name: 'translate',
              keyframes: [
                {
                  offset: phase === 'enter' ? 0 : 1,
                  value: {
                    kind: 'literal',
                    value: phase === 'enter' ? '120px 20px 3px' : '300px 0px',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

/** Adds a phase-only input; the alias variant retains an earlier physical fallback. */
function withLiveEnter(value: Definition, alias: boolean): Definition {
  const property = alias ? 'inline-size' : 'translate'
  const layers: Definition['layers'] = alias
    ? [
        {
          name: 'base',
          targets: [
            {
              name: 'self',
              properties: [
                { name: 'width', value: { kind: 'literal', value: '120px' } },
                { name: 'inline-size', value: { kind: 'literal', value: '100px' } },
              ],
            },
          ],
        },
        {
          name: 'active',
          when: reference('enabled'),
          targets: [
            {
              name: 'self',
              properties: [
                {
                  name: 'inline-size',
                  value: { kind: 'binding', expression: reference('movement') },
                },
              ],
            },
          ],
        },
      ]
    : value.layers

  return {
    ...value,
    parameters: [...(value.parameters ?? []), { name: 'phase', type: 'number' }],
    letBindings: alias
      ? value.letBindings?.map((binding) => ({
          ...binding,
          initializer:
            binding.initializer.kind === 'call'
              ? {
                  ...binding.initializer,
                  arguments: binding.initializer.arguments.filter(
                    (argument) => argument.name !== 'component',
                  ),
                }
              : binding.initializer,
        }))
      : value.letBindings,
    layers,
    events: [
      {
        name: 'invalid',
        when: {
          kind: 'binary',
          operator: '==',
          left: reference('phase'),
          right: { kind: 'number', value: 0 },
        },
      },
    ],
    enter: {
      timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
      targets: [
        {
          name: 'self',
          properties: [
            {
              name: property,
              keyframes: [
                {
                  offset: 0,
                  value: {
                    kind: 'template',
                    parts: [
                      {
                        kind: 'binary',
                        operator: '/',
                        left: { kind: 'number', value: 1 },
                        right: reference('phase'),
                      },
                      alias ? 'px' : 'px 20px 3px',
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

function setupSwitchingControllers() {
  const fixture = setup(
    'x',
    (value) => ({
      ...value,
      parameters: [
        ...(value.parameters ?? []),
        { name: 'secondInput', type: 'number' },
        { name: 'useSecond', type: 'boolean' },
      ],
      letBindings: [
        ...(value.letBindings ?? []),
        {
          name: 'second',
          initializer: {
            kind: 'call',
            function: 'link',
            arguments: [
              { name: 'input', value: reference('secondInput') },
              { name: 'component', value: { kind: 'string', value: 'x' } },
            ],
          },
        },
      ],
      layers: [
        ...value.layers.map((layer) => ({
          ...layer,
          targets: layer.targets.map((target) => ({
            ...target,
            properties:
              layer.name === 'base'
                ? [
                    ...target.properties,
                    {
                      name: '--second-observed',
                      value: {
                        kind: 'template' as const,
                        parts: [reference('second', 'value', 'x')],
                      },
                    },
                  ]
                : target.properties,
          })),
        })),
        {
          name: 'second',
          when: reference('useSecond'),
          targets: [
            {
              name: 'self',
              properties: [
                { name: 'translate', value: { kind: 'binding', expression: reference('second') } },
              ],
            },
          ],
        },
      ],
    }),
    { secondInput: 0, useSecond: false },
  )
  let inputs = { ...fixture.inputs, secondInput: 0, useSecond: false }

  return {
    ...fixture,
    update: (changes: Partial<typeof inputs>) => {
      inputs = { ...inputs, ...changes }
      fixture.instance.updateParameters(inputs)
    },
  }
}

async function frame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose()
  for (const element of elements.splice(0)) element.remove()
})

describe('relative property controllers', () => {
  it.each([
    ['width', 'inline-size', 'width'],
    ['inline-size', 'width', 'width'],
    ['left', 'inset-inline-start', 'left'],
    ['inset-inline-start', 'left', 'left'],
  ])('releases %s control while %s owns its physical address', (property, override, physical) => {
    const element = document.createElement('div')
    element.style.cssText = 'position:relative;width:100px;height:80px;left:100px;'
    document.body.append(element)
    elements.push(element)
    const errors: RuntimeDiagnostic[] = []
    const instance = new LivaInstance(
      {
        name: 'aliasOwnership',
        parameters: [
          { name: 'input', type: 'number' },
          { name: 'covered', type: 'boolean' },
        ],
        letBindings: [
          {
            name: 'movement',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [{ name: 'input', value: reference('input') }],
            },
          },
        ],
        layers: [
          {
            name: 'control',
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: property,
                    value: {
                      kind: 'binding',
                      expression: reference('movement'),
                    },
                  },
                ],
              },
            ],
          },
          {
            name: 'override',
            when: reference('covered'),
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: override,
                    value: {
                      kind: 'literal',
                      value: '200px',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { input: 0, covered: false },
      (error) => errors.push(error),
    )
    instances.push(instance)
    instance.bind([['self', element]])

    instance.updateParameters({ input: 10, covered: false })

    expect(getComputedStyle(element).getPropertyValue(physical)).toBe('110px')

    instance.updateParameters({ input: 10, covered: true })
    instance.updateParameters({ input: 50, covered: true })

    expect(getComputedStyle(element).getPropertyValue(physical)).toBe('200px')

    instance.updateParameters({ input: 50, covered: false })

    expect(getComputedStyle(element).getPropertyValue(physical)).toBe('200px')

    instance.updateParameters({ input: 60, covered: false })

    expect(getComputedStyle(element).getPropertyValue(physical)).toBe('210px')
    expect(errors).toEqual([])
  })

  it.each([
    {
      property: 'translate',
      exit: 'translate',
      base: '100px 20px 3px',
      endpoint: '200px 20px 3px',
      component: 'x',
    },
    {
      property: 'inset',
      exit: 'left',
      base: '10px 20px 30px 40px',
      endpoint: '200px',
      component: undefined,
    },
  ])(
    'reacquires $property immediately after scoped $exit ownership ends',
    ({ property, exit, base, endpoint, component }) => {
      const element = document.createElement('div')

      element.style.cssText = 'position:relative;width:100px;height:80px;'
      document.body.append(element)
      elements.push(element)

      const errors: RuntimeDiagnostic[] = []
      const instance = new LivaInstance(
        {
          name: 'presence-controller',
          parameters: [{ name: 'input', type: 'number' }],
          letBindings: [
            {
              name: 'movement',
              initializer: {
                kind: 'call',
                function: 'link',
                arguments: [
                  { name: 'input', value: reference('input') },
                  ...(component
                    ? [{ name: 'component', value: { kind: 'string' as const, value: component } }]
                    : []),
                ],
              },
            },
          ],
          layers: [
            {
              name: 'base',
              targets: [
                {
                  name: 'self',
                  properties: [{ name: property, value: { kind: 'literal', value: base } }],
                },
              ],
            },
            {
              name: 'control',
              targets: [
                {
                  name: 'self',
                  properties: [
                    {
                      name: property,
                      value: { kind: 'binding', expression: reference('movement') },
                    },
                  ],
                },
              ],
            },
          ],
          leave: {
            timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: exit,
                    keyframes: [{ offset: 1, value: { kind: 'literal', value: endpoint } }],
                  },
                ],
              },
            ],
          },
        },
        { input: 0 },
        (error) => errors.push(error),
      )

      instances.push(instance)
      instance.bind([['self', element]])
      instance.updateParameters({ input: 10 })

      const session = new PresenceOperation(capturePresence(instance, 'leave', ['self']), 'leave')

      try {
        session.initialize()
        session.play()

        const animation = element.getAnimations()[0]

        animation.pause()
        animation.currentTime = 500
        instance.updateParameters({ input: 50 })

        const before = decodeProperty(element, property)?.values

        session.cancel('superseded')

        expect(decodeProperty(element, property)?.values).toEqual(before)

        instance.updateParameters({ input: 60 })

        const after = decodeProperty(element, property)?.values

        if (!before || !after) throw new Error('Expected readable controlled property')

        expect(after[0]).toBeCloseTo(before[0] + 10, 6)
        expect(after.slice(1)).toEqual(before.slice(1))
        expect(errors).toEqual([])
      } finally {
        session.cancel('owner-teardown')
      }
    },
  )

  it.each([
    { label: 'bound', hidden: false, alias: false },
    { label: 'unreadable fallback', hidden: true, alias: false },
    { label: 'unreadable fallback with source-ordered aliases', hidden: true, alias: true },
  ])(
    'rejects invalid still-applicable enter expressions with an unchanged $label controller',
    async ({ hidden, alias }) => {
      const { instance, element, inputs, errors } = setup(
        'x',
        (value) => withLiveEnter(value, alias),
        { enabled: true, phase: 1 },
      )

      if (hidden) {
        element.style.display = 'none'
        instance.updateParameters({ ...inputs, phase: 1 })
      }

      const work = capturePresence(instance, 'enter', ['self'])

      const session = new PresenceOperation(work, 'enter')
      const events: string[] = []

      instance.onEvent = (event) => events.push(event)

      try {
        session.initialize()
        session.play()

        const original = instance.animations[0]

        original.pause()
        original.currentTime = 0

        const acquire = vi.spyOn(PropertyMotion.prototype, 'beginControl')
        const release = vi.spyOn(PropertyMotion.prototype, 'endControl')

        try {
          instance.updateParameters({ ...inputs, phase: 0 })

          await Promise.resolve()

          expect(acquire).not.toHaveBeenCalled()
          expect(release).not.toHaveBeenCalled()
        } finally {
          acquire.mockRestore()
          release.mockRestore()
        }

        expect(errors).toEqual([
          expect.objectContaining({
            code: 'runtime.expression',
            message: 'Error: Expression result must be finite',
          }),
        ])
        expect(events).toEqual([])
        expect(session.isFinished).toBe(false)
        expect(instance.animations).toContain(original)

        element.style.display = ''
        instance.updateParameters({ ...inputs, phase: 2 })

        const replacement = instance.animations[0]

        expect(replacement).not.toBe(original)

        replacement.finish()

        expect(await session.finished).toBe('completed')
        expect(errors).toHaveLength(1)
        expect(getComputedStyle(element).getPropertyValue(alias ? 'width' : 'translate')).toBe(
          alias ? '100px' : '100px 20px 3px',
        )
      } finally {
        session.cancel('owner-teardown')
      }
    },
  )

  it('accepts an alias takeover without evaluating the now-inactive controller enter expression', async () => {
    const { instance, element, inputs, errors } = setup(
      'x',
      (value) => {
        const source = withLiveEnter(value, true)

        return {
          ...source,
          parameters: [...(source.parameters ?? []), { name: 'covered', type: 'boolean' }],
          layers: [
            ...source.layers,
            {
              name: 'cover',
              when: reference('covered'),
              targets: [
                {
                  name: 'self',
                  properties: [{ name: 'width', value: { kind: 'literal', value: '150px' } }],
                },
              ],
            },
          ],
        }
      },
      { enabled: true, phase: 1, covered: false },
    )

    element.style.display = 'none'
    instance.updateParameters({ ...inputs, phase: 1, covered: false })

    const session = new PresenceOperation(capturePresence(instance, 'enter', ['self']), 'enter')
    const events: string[] = []

    instance.onEvent = (event) => events.push(event)

    try {
      session.initialize()
      session.play()
      instance.updateParameters({ ...inputs, phase: 0, covered: true })

      expect(await session.finished).toBe('completed')
      expect(events).toEqual(['invalid'])
      expect(getComputedStyle(element).width).toBe('150px')
      expect(errors).toEqual([])
    } finally {
      session.cancel('owner-teardown')
    }
  })

  it('reacquires one logical controller for every receiver after scoped presence releases it', async () => {
    const { instance, element, inputs, errors } = setup(
      'x',
      (value) => ({
        ...value,
        leave: {
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          targets: [
            {
              name: 'self',
              properties: [
                {
                  name: 'translate',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '200px 20px 3px' } }],
                },
              ],
            },
          ],
        },
      }),
      { enabled: true },
    )
    const other = document.createElement('div')

    other.style.cssText = element.style.cssText
    document.body.append(other)
    elements.push(other)
    instance.bind([
      ['self', element],
      ['self', other],
    ])
    instance.updateParameters({ ...inputs, input: 10 })

    const session = new PresenceOperation(
      capturePresence(instance, 'leave', ['self'], { element: element }),
      'leave',
    )

    try {
      session.initialize()
      session.play()

      for (const animation of other.getAnimations()) animation.finish()

      await Promise.resolve()

      instance.updateParameters({ ...inputs, input: 50 })

      expect(decodeProperty(other, 'translate')?.values[0]).toBe(100)

      session.cancel('superseded')

      expect(decodeProperty(other, 'translate')?.values[0]).toBe(100)

      instance.updateParameters({ ...inputs, input: 60 })

      expect(decodeProperty(other, 'translate')?.values[0]).toBe(110)
      expect(decodeProperty(element, 'translate')?.values[0]).toBe(110)
      expect(errors).toEqual([])
    } finally {
      session.cancel('owner-teardown')
    }
  })

  it.each([
    { label: 'fresh input', start: 1060, numeric: true },
    {
      label: 'expired input after an unchanged update and delayed release',
      start: 1110,
      numeric: false,
    },
  ])(
    'preserves original input freshness for detached leave: $label',
    async ({ start, numeric }) => {
      let now = 1000
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
      const { instance, element, inputs, errors } = setup(
        'x',
        (value) => ({
          ...value,
          leave: {
            timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 },
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: 'translate',
                    keyframes: [{ offset: 1, value: { kind: 'literal', value: '300px 20px 3px' } }],
                  },
                ],
              },
            ],
          },
        }),
        { enabled: true },
      )

      try {
        now = 1020
        instance.updateParameters({ ...inputs, input: 20 })

        const work = capturePresence(instance, 'leave', ['self'])

        now = numeric ? 1040 : 1080
        instance.updateParameters({ ...inputs, input: 20 })
        instance.dispose()
        now = start

        const session = new PresenceOperation(work, 'leave')

        try {
          session.initialize()
          session.play()

          const animation = element.getAnimations()[0]

          if (!(animation.effect instanceof KeyframeEffect))
            throw new Error('Expected leave effect')

          expect(animation.effect.getKeyframes().length > 2).toBe(numeric)

          animation.finish()

          expect(await session.finished).toBe('completed')
          expect(errors).toEqual([])
        } finally {
          session.cancel('owner-teardown')
        }
      } finally {
        clock.mockRestore()
      }
    },
  )

  it.each<Expression>([reference('movement', 'value'), { kind: 'number', value: 1 }])(
    'rejects a non-controller property binding: %j',
    (expression) => {
      expect(() =>
        setup('x', (value) => ({
          ...value,
          layers: value.layers.map((layer) => ({
            ...layer,
            targets: layer.targets.map((target) => ({
              ...target,
              properties: target.properties.map((property) =>
                property.value.kind === 'binding'
                  ? { ...property, value: { kind: 'binding', expression } }
                  : property,
              ),
            })),
          })),
        })),
      ).toThrow('Property attachment requires a controller capability')
    },
  )

  it('replaces a source call moved to another receiving address during HMR', () => {
    const { instance, element, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 30 })
    const original = definition()
    const replacement = document.createElement('div')
    replacement.style.cssText = 'width:200px;height:80px;translate:250px 40px 5px;'
    document.body.append(replacement)
    elements.push(replacement)
    const updated: Definition = {
      ...original,
      layers: original.layers.map((layer) => ({
        ...layer,
        targets: layer.targets.map((target) => ({ ...target, name: 'other' })),
      })),
    }

    instance.replaceDefinition(updated)
    instance.bind([['other', replacement]])
    instance.updateParameters({ ...inputs, enabled: true, input: 40 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 20, 3])
    expect(decodeProperty(replacement, 'translate')?.values).toEqual([260, 40, 5])
    expect(errors).toEqual([])
  })

  it('reports an undecodable visible property once through the instance diagnostic channel', async () => {
    const element = document.createElement('div')
    element.style.cssText = 'width:100px;height:100px;rotate:x 20deg;'
    document.body.append(element)
    elements.push(element)
    const errors: RuntimeDiagnostic[] = []
    const instance = new LivaInstance(
      {
        name: 'rotation',
        letBindings: [
          {
            name: 'rotation',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [{ name: 'input', value: { kind: 'number', value: 0 } }],
            },
          },
        ],
        layers: [
          {
            name: 'active',
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: 'rotate',
                    value: {
                      kind: 'binding',
                      expression: reference('rotation'),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {},
      (error) => errors.push(error),
    )
    instances.push(instance)

    instance.bind([['self', element]])
    await frame()
    await frame()

    expect(errors.map((error) => error.code)).toEqual(['runtime.controller'])
    expect(element.style.rotate).toBe('x 20deg')
  })

  it('reacquires the displayed origin when a previously replaced controller becomes the owner again', () => {
    const { element, update, errors } = setupSwitchingControllers()

    update({ enabled: true, input: 0 })
    update({ input: 20 })
    update({ useSecond: true, secondInput: 0 })
    update({ secondInput: 30 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([150, 20, 3])

    update({ useSecond: false })

    expect(decodeProperty(element, 'translate')?.values).toEqual([150, 20, 3])

    update({ input: 30 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([160, 20, 3])
    expect(errors).toEqual([])
  })

  it('hands the replacement owner velocity to the spring when all controller bindings end', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)

    try {
      const { instance, element, update, errors } = setupSwitchingControllers()

      update({ enabled: true, input: 0 })
      clock.mockReturnValue(110)
      update({ input: 20 })
      clock.mockReturnValue(120)
      update({ useSecond: true, secondInput: 0 })
      clock.mockReturnValue(130)
      update({ secondInput: 30 })

      expect(decodeProperty(element, 'translate')?.values).toEqual([150, 20, 3])

      clock.mockReturnValue(140)
      update({ enabled: false, useSecond: false, destination: 200 })
      const animation = instance.animations[0]

      if (!(animation?.effect instanceof KeyframeEffect)) throw new Error('Expected return spring')

      // The second owner moved 30px over 10ms; its derivative must replace the first owner's 2px/ms.
      const expected = springMotion(
        { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
        [150, 20, 3],
        [200, 20, 3],
        [3, 0, 0],
      )
      // Compare at an authored sample boundary, avoiding WAAPI interpolation between samples.
      const sampleTime = animation.effect.getKeyframes()[1].computedOffset * expected.durationMs
      animation.pause()
      animation.currentTime = sampleTime

      expect(decodeProperty(element, 'translate')?.values[0]).toBeCloseTo(
        expected.sample(sampleTime).value[0],
        3,
      )
      expect(errors).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it('retains common styles when a state controller is unavailable', async () => {
    const { instance, element, inputs, errors } = setup('x', (value) => ({
      ...value,
      layers: [
        {
          ...value.layers[0],
          initialState: 'idle',
          states: [
            { name: 'idle', targets: [] },
            {
              name: 'controlled',
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
          transitions: [
            {
              from: 'idle',
              to: 'controlled',
              when: reference('enabled'),
              transition: { targets: [] },
            },
          ],
        },
      ],
    }))
    element.style.display = 'none'

    instance.updateParameters({ ...inputs, enabled: true, input: 20 })
    await frame()

    expect(element.style.translate).toBe('100px 20px 3px')
    expect(instance.composition.states.base).toBe('controlled')
    expect(errors).toEqual([])
  })

  it('keeps a session when declaration precedence changes at the same address', () => {
    const { instance, element, inputs, errors } = setup('x', (value) => ({
      ...value,
      layers: [
        ...value.layers,
        {
          name: 'second',
          when: {
            kind: 'binary',
            operator: '>',
            left: reference('input'),
            right: { kind: 'number', value: 20 },
          },
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
    }))
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })

    instance.updateParameters({ ...inputs, enabled: true, input: 30 })
    instance.updateParameters({ ...inputs, enabled: true, input: 40 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([130, 20, 3])
    expect(errors).toEqual([])
  })

  it.each(['enter', 'leave'] as const)(
    'keeps ordinary controller inspection isolated during active %s',
    async (phase) => {
      const { instance, inputs, errors } = setup(
        'x',
        (value) => withTranslatePresence(value, phase),
        {
          enabled: true,
        },
      )
      const inspect = () =>
        instance
          .inspectComposition(instance.composition)
          .presentation.targets.find((target) => target.name === 'self')
          ?.properties.find((property) => property.name === 'translate')?.value

      instance.updateParameters({ ...inputs, input: 20 })

      const before = inspect()
      const session = new PresenceOperation(capturePresence(instance, phase, ['self']), phase)

      expect(before).toBe('120px 20px 3px')

      try {
        session.play()

        expect(inspect()).toBe(before)

        session.cancel('owner-teardown')

        expect(await session.finished).toBe('owner-teardown')
        expect(inspect()).toBe(before)
        expect(errors).toEqual([])
      } finally {
        session.cancel('owner-teardown')
      }
    },
  )

  it('previews the ordinary controller snapshot while leave playback continues', () => {
    const { instance, element, inputs, errors } = setup(
      'x',
      (value) => withTranslatePresence(value, 'leave'),
      {
        enabled: true,
      },
    )

    instance.updateParameters({ ...inputs, input: 20 })

    const session = new PresenceOperation(capturePresence(instance, 'leave', ['self']), 'leave')

    try {
      session.play()

      const leave = element.getAnimations()[0]

      instance.previewComposition(instance.composition, instance.composition)

      expect(decodeProperty(element, 'translate')?.values).toEqual([120, 20, 3])
      expect(instance.animations).toEqual([])
      expect(element.getAnimations()).toContain(leave)
      expect(session.isFinished).toBe(false)

      instance.endCompositionPreview()

      expect(session.isFinished).toBe(false)
      expect(errors).toEqual([])
    } finally {
      session.cancel('owner-teardown')
    }
  })

  it.each(['completion', 'reduced motion'] as const)(
    'reacquires control before the first input after leave %s during preview',
    async (completion) => {
      const media = matchMedia('(prefers-reduced-motion: reduce)')
      const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
      const reduced = vi.spyOn(media, 'matches', 'get').mockReturnValue(false)
      const { instance, element, inputs, errors } = setup(
        'x',
        (value) => ({
          ...withTranslatePresence(value, 'leave'),
          layers: value.layers.map((layer) => ({
            ...layer,
            targets: layer.targets.map((target) => ({
              ...target,
              properties: [
                ...target.properties,
                {
                  name: 'scale',
                  timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
                  value: { kind: 'literal', value: layer.name === 'base' ? '1' : '2' },
                },
              ],
            })),
          })),
        }),
        { enabled: true },
      )

      instance.updateParameters({ ...inputs, input: 20 })

      const session = new PresenceOperation(capturePresence(instance, 'leave', ['self']), 'leave')

      try {
        session.play()

        const leave = element.getAnimations()[0]

        instance.updateParameters({ ...inputs, input: 30 })
        instance.previewComposition(
          { layers: { base: true, active: false }, states: {} },
          instance.composition,
        )

        expect(instance.animations.length).toBeGreaterThan(0)

        if (completion === 'completion') {
          leave.finish()
        } else {
          reduced.mockReturnValue(true)
          media.dispatchEvent(new Event('change'))
        }

        await expect.poll(() => session.isFinished, { timeout: 300 }).toBe(true)

        expect(await session.finished).toBe('completed')

        instance.endCompositionPreview()

        const before = decodeProperty(element, 'translate')

        if (!before) throw new Error('Expected readable control origin after preview')

        instance.updateParameters({ ...inputs, input: 40 })

        expect(decodeProperty(element, 'translate')?.values[0]).toBe(before.values[0] + 10)
        expect(errors).toEqual([])
      } finally {
        session.cancel('owner-teardown')
        reduced.mockRestore()
        factory.mockRestore()
      }
    },
  )

  it('freezes controller observations while scrubbing and resumes the live session afterwards', async () => {
    const { instance, element, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 30 })
    const active = { layers: { base: true, active: true }, states: {} }
    const inactive = { layers: { base: true, active: false }, states: {} }

    instance.previewComposition(active, inactive)
    for (const animation of instance.animations) animation.currentTime = 100
    await frame()
    instance.previewComposition(active, active)

    expect(decodeProperty(element, 'translate')?.values).toEqual([120, 20, 3])
    expect(instance.animations).toHaveLength(0)

    instance.updateParameters({ ...inputs, enabled: true, input: 40 })

    expect(errors).toEqual([])
  })

  it('freezes inactive controller observations during preview and resumes them when preview ends', async () => {
    const { instance, element, update, errors } = setupSwitchingControllers()
    update({ enabled: true, input: 10 })
    update({ input: 30 })
    const active = { layers: { base: true, active: true, second: false }, states: {} }
    const inactive = { layers: { base: true, active: false, second: false }, states: {} }
    const observeSecond = () =>
      instance
        .inspectComposition(inactive)
        .presentation.targets.find((target) => target.name === 'self')
        ?.properties.find((property) => property.name === '--second-observed')?.value

    instance.previewComposition(active, inactive)

    expect(instance.animations).toHaveLength(1)

    instance.animations[0].currentTime = 50

    await frame()

    expect(decodeProperty(element, 'translate')?.values[0]).not.toBe(120)
    expect(observeSecond()).toBe('120')

    instance.endCompositionPreview()
    element.style.translate = '200px 20px 3px'

    expect(observeSecond()).toBe('200')
    expect(errors).toEqual([])
  })

  it('keeps the live owner selected when a preview displays a different controller', () => {
    const { instance, element, update, errors } = setupSwitchingControllers()
    update({ enabled: true, input: 10 })
    update({ input: 30 })

    instance.previewComposition(
      { layers: { base: true, active: true, second: false }, states: {} },
      { layers: { base: true, active: false, second: true }, states: {} },
    )
    instance.endCompositionPreview()

    // The live owner must apply its final 10px input delta before releasing to the spring.
    update({ enabled: false, input: 40 })

    expect(instance.animations).toHaveLength(1)

    instance.animations[0].pause()
    instance.animations[0].currentTime = 0

    expect(decodeProperty(element, 'translate')?.values).toEqual([130, 20, 3])
    expect(errors).toEqual([])
  })

  it('replaces target motion histories and detaches resources from the old target', async () => {
    const { instance, element, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 40 })
    const replacement = document.createElement('div')
    replacement.style.cssText = 'width:200px;height:80px;translate:250px 0px;'
    document.body.append(replacement)
    elements.push(replacement)

    instance.bind([['self', replacement]])
    instance.updateParameters({ ...inputs, enabled: true, input: 50 })
    await frame()

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 20, 3])
    expect(decodeProperty(replacement, 'translate')?.values).toEqual([260, 0, 0])
    expect(errors).toEqual([])
  })

  it('preserves normal presentation while a controller is unreadable and recovers without a jump', async () => {
    const { instance, element, inputs, errors } = setup('x', (value) => ({
      ...value,
      layers: value.layers.map((layer, index) =>
        index === 0
          ? {
              ...layer,
              targets: [{ name: 'self', properties: [] }],
            }
          : layer,
      ),
    }))
    element.style.display = 'none'

    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 30 })
    await frame()

    expect(element.style.translate).toBe('100px 20px 3px')

    element.style.display = 'block'
    await frame()
    await frame()

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 20, 3])
    expect(errors).toEqual([])
  })

  it('captures mid-input origins once and preserves unmapped translation axes', () => {
    const { element, instance, inputs, errors } = setup()

    instance.updateParameters({ ...inputs, enabled: true, input: 50 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 20, 3])

    instance.updateParameters({ ...inputs, enabled: true, input: 70 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([120, 20, 3])
    expect(getComputedStyle(element).getPropertyValue('--observed').trim()).toBe('120')
    expect(instance.animations).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it('rebases sensitivity changes without moving and ignores obscured destinations', () => {
    const { element, instance, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 30 })

    instance.updateParameters({ ...inputs, enabled: true, input: 30, sensitivity: -2 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([120, 20, 3])

    instance.updateParameters({
      ...inputs,
      enabled: true,
      input: 40,
      sensitivity: -2,
      destination: 999,
    })

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 20, 3])
    expect(errors).toEqual([])
  })

  it('maps the scalar source to the selected destination component', () => {
    const { element, instance, inputs, errors } = setup('y')
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })

    instance.updateParameters({ ...inputs, enabled: true, input: 30 })

    expect(decodeProperty(element, 'translate')?.values).toEqual([100, 40, 3])
    expect(errors).toEqual([])
  })

  it('samples inactive springs on evaluation and reacquires their displayed origin', async () => {
    const { element, instance, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 50 })

    instance.updateParameters({ ...inputs, enabled: false, input: 50 })
    const animation = instance.animations[0]
    if (!animation) throw new Error('Expected a return spring')
    animation.pause()
    animation.currentTime = 100
    const displayed = decodeProperty(element, 'translate')?.values

    await frame()

    // Animation frames alone no longer publish controller observations.
    expect(Number(getComputedStyle(element).getPropertyValue('--observed'))).toBe(140)

    instance.updateParameters({ ...inputs, enabled: true, input: 50 })

    expect(Number(getComputedStyle(element).getPropertyValue('--observed'))).toBeCloseTo(
      displayed?.[0] ?? 0,
      2,
    )
    expect(decodeProperty(element, 'translate')?.values[0]).toBeCloseTo(displayed?.[0] ?? 0, 2)
    expect(instance.animations).toHaveLength(0)

    instance.updateParameters({ ...inputs, enabled: true, input: 60 })

    expect(decodeProperty(element, 'translate')?.values[0]).toBeCloseTo(
      (displayed?.[0] ?? 0) + 10,
      2,
    )
    expect(errors).toEqual([])
  })

  it('rolls back invalid computed input without changing the active pose', () => {
    const { element, instance, inputs, errors } = setup()
    instance.updateParameters({ ...inputs, enabled: true, input: 10 })
    instance.updateParameters({ ...inputs, enabled: true, input: 30 })
    const before = decodeProperty(element, 'translate')?.values

    instance.updateParameters({ ...inputs, enabled: true, input: Infinity })

    expect(decodeProperty(element, 'translate')?.values).toEqual(before)
    expect(errors.at(-1)?.code).toBe('runtime.parameter')
  })
})
