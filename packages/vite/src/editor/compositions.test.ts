import { describe, expect, it } from 'vite-plus/test'
import type { Definition } from '@liva/runtime'
import { compatibleTransition, copyComposition, selectTransition } from './compositions.ts'

const definition: Definition = {
  name: 'motion',

  layers: [
    {
      name: 'machine',
      targets: [],
      initialState: 'idle',
      states: [
        { name: 'idle', targets: [] },
        { name: 'active', targets: [] },
      ],
      transitions: [0, 1].map(() => ({
        from: 'idle',
        to: 'active',
        when: { kind: 'boolean', value: false },
        transition: { targets: [] },
      })),
    },
  ],
}
const from = { layers: { base: true, hover: false }, states: { machine: 'active', other: 'done' } }
const to = { layers: { base: false, hover: true }, states: { machine: 'idle', other: 'initial' } }

describe('composition selection', () => {
  it('copies each selection map independently', () => {
    const copy = copyComposition(from)
    Object.assign(copy.layers, { base: false })
    Object.assign(copy.states, { machine: 'idle' })

    expect(from.layers.base).toBe(true)
    expect(from.states.machine).toBe('active')
  })

  it('changes only the selected transition layer and retains declaration identity', () => {
    const identity = { layer: 'machine', index: 1 }
    const next = selectTransition(definition, from, to, identity)

    expect(next).toEqual({
      from: { ...from, states: { ...from.states, machine: 'idle' } },
      to: { ...to, states: { ...to.states, machine: 'active' } },
    })
    expect(compatibleTransition(definition, next.from, next.to, identity)).toBe(identity)
    expect(compatibleTransition(definition, next.to, next.from, identity)).toBeUndefined()
  })

  it.each([undefined, { layer: 'missing', index: 0 }, { layer: 'machine', index: 8 }])(
    'clears unavailable transition selections: %j',
    (identity) => {
      expect(compatibleTransition(definition, from, to, identity)).toBeUndefined()
    },
  )

  it('rejects unknown declarations', () => {
    expect(() => selectTransition(definition, from, to, { layer: 'missing', index: 0 })).toThrow(
      'Unknown transition',
    )
  })
})
