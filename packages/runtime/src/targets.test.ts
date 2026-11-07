import { describe, expect, it } from 'vite-plus/test'
import { rootTargetBindings } from './targets.ts'

describe('rootTargetBindings', () => {
  it('preserves named aliases while reserving the motion root', () => {
    const root = {}
    const child = {}
    const named = new Map([
      ['self', child],
      ['alias', root],
      ['child', child],
    ])

    const bindings = new Map(rootTargetBindings(root, named))

    expect(bindings.get('self')).toBe(root)
    expect(bindings.get('alias')).toBe(root)
    expect(bindings.get('child')).toBe(child)
    expect(named.get('self')).toBe(child)
  })

  it('preserves repeated named elements for lifecycle groups and duplicate validation', () => {
    const root = {}
    const first = {}
    const second = {}

    const bindings = rootTargetBindings(root, [
      ['item', first],
      ['item', second],
    ])

    expect(bindings).toEqual([
      ['self', root],
      ['item', first],
      ['item', second],
    ])
  })

  it('rebinds the built-in target when the motion root changes', () => {
    const original = {}
    const replacement = {}
    const previous = rootTargetBindings(original, [])

    const bindings = new Map(rootTargetBindings(replacement, previous))

    expect(bindings.get('self')).toBe(replacement)
    expect(new Map(previous).get('self')).toBe(original)
  })
})
