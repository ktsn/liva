import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { Definition, Expression } from '../model/definition.ts'
import { LivaInstance, type RuntimeDiagnostic } from '../execution/instance.ts'
import { decodeProperty } from './property-codec.ts'

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
) {
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:200px;height:80px;translate:100px 20px 3px;'
  document.body.append(element)
  elements.push(element)
  const errors: RuntimeDiagnostic[] = []
  const inputs = { input: 0, enabled: false, sensitivity: 1, destination: 100 }
  const instance = new LivaInstance(transform(definition(component)), inputs, (error) =>
    errors.push(error),
  )
  instances.push(instance)
  instance.bind([['self', element]])

  return { element, instance, inputs, errors }
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

  it('ends a session when a different controller takes the same property', () => {
    const { instance, element, inputs, errors } = setup('x', (value) => ({
      ...value,
      letBindings: [
        ...(value.letBindings ?? []),
        { ...(value.letBindings ?? [])[0], name: 'second' },
      ],
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
                    expression: reference('second'),
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
