import { afterEach, describe, expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
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
    const { instance, element, errors } = setup({ ...definition, enter: { targets: [] } })
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
