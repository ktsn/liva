import { describe, expect, it } from 'vite-plus/test'
import type { Definition, Expression, Layer } from './definition.ts'
import { layerTargets, resolveLayers } from './layers.ts'

const ref = (name: string): Expression => ({ kind: 'reference', path: [name] })
const targets = (properties: Record<string, string>) => [
  {
    name: 'body',
    properties: Object.entries(properties).map(([name, value]) => ({ name, value })),
  },
]
const definition = (layers: readonly Layer[]): Definition => ({
  name: 'button',
  layers,
  states: [],
  directionalTransitions: [],
})
const styles = (result: ReturnType<typeof resolveLayers>) =>
  Object.fromEntries(
    result.presentation.targets[0].properties.map((property) => [property.name, property.value]),
  )

const reactive = definition([
  { name: 'base', targets: targets({ scale: '1', opacity: '1' }) },
  { name: 'hover', when: ref('hover'), targets: targets({ scale: '1.1' }) },
  { name: 'press', when: ref('press'), targets: targets({ scale: '.9' }) },
  { name: 'selected', when: ref('selected'), targets: targets({ opacity: '.5' }) },
])

const machine: Layer = {
  name: 'submission',
  targets: targets({ opacity: '1' }),
  initialState: 'idle',
  states: [
    { name: 'idle', targets: targets({ scale: '1' }) },
    { name: 'loading', targets: targets({ scale: '.8' }) },
    { name: 'success', targets: targets({ scale: '1.2' }) },
  ],
  transitions: [
    { from: 'idle', to: 'loading', when: ref('loading'), transition: { targets: [] } },
    { from: 'idle', to: 'success', when: ref('completed'), transition: { targets: [] } },
    { from: 'success', to: 'idle', when: ref('completed'), transition: { targets: [] } },
  ],
}

describe('layer cascade', () => {
  it('contributes no styles when the definition has no layers', () => {
    const result = resolveLayers({ name: 'empty', states: [], directionalTransitions: [] }, {})

    expect(result.presentation.targets).toEqual([])
  })

  it('overrides per property in source order and restores obscured layers', () => {
    const active = resolveLayers(reactive, { hover: true, press: true, selected: true })
    const released = resolveLayers(reactive, { hover: true, press: false, selected: true })

    expect(styles(active)).toEqual({ scale: '.9', opacity: '.5' })
    expect(styles(released)).toEqual({ scale: '1.1', opacity: '.5' })
  })

  it('resolves final inputs independently of delivery order', () => {
    const first = resolveLayers(reactive, { selected: false, press: true, hover: true })
    const second = resolveLayers(reactive, { hover: true, press: true, selected: false })

    expect(first.presentation).toEqual(second.presentation)
  })

  it('re-evaluates CSS interpolation without adding units', () => {
    const source = definition([
      {
        name: 'base',
        targets: [
          {
            name: 'body',
            properties: [{ name: 'translate', value: '', template: [ref('x'), 'px 0'] }],
          },
        ],
      },
    ])

    expect(styles(resolveLayers(source, { x: 10 })).translate).toBe('10px 0')
    expect(styles(resolveLayers(source, { x: 20 })).translate).toBe('20px 0')
  })
})

describe('layer state machines', () => {
  it('reports an invalid current state instead of silently dropping a machine', () => {
    expect(() =>
      resolveLayers(definition([{ ...machine, initialState: 'missing' }]), {
        loading: false,
        completed: false,
      }),
    ).toThrow('Unknown current state')
  })

  it('evaluates initially true guards once and lets the last declaration win', () => {
    const result = resolveLayers(definition([machine]), { loading: true, completed: true })

    expect(result.states.get('submission')).toBe('success')
    expect(styles(result)).toEqual({ opacity: '1', scale: '1.2' })
  })

  it('retains state without eligible outgoing transitions', () => {
    const first = resolveLayers(definition([machine]), { loading: true, completed: false })
    const next = resolveLayers(
      definition([machine]),
      { loading: false, completed: false },
      first.states,
    )

    expect(next.states.get('submission')).toBe('loading')
    expect(next.transitions.size).toBe(0)
  })

  it('advances cycles only on subsequent updates', () => {
    const first = resolveLayers(definition([machine]), { loading: false, completed: true })
    const second = resolveLayers(
      definition([machine]),
      { loading: false, completed: true },
      first.states,
    )

    expect(first.states.get('submission')).toBe('success')
    expect(second.states.get('submission')).toBe('idle')
  })

  it('keeps machines independent and cascades later layer values', () => {
    const source = definition([
      machine,
      { ...machine, name: 'other' },
      { name: 'pressed', targets: targets({ scale: '.5' }) },
    ])
    const result = resolveLayers(source, { loading: true, completed: false })

    expect([...result.states]).toEqual([
      ['submission', 'loading'],
      ['other', 'loading'],
    ])
    expect(styles(result).scale).toBe('.5')
    expect(layerTargets(source).length).toBeGreaterThan(source.layers!.length)
  })
})
