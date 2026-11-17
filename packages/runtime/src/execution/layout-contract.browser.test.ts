import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { nativeEffects } from '../__test__/helpers/assembly.ts'
import { decodeBundle, type Definition } from '../model/definition.ts'
import fixture from '../../../../fixtures/layout-config.json'

const harness = createBrowserRuntimeHarness()
const compiled = decodeBundle(JSON.stringify(fixture)).definitions[0]

afterEach(() => {
  harness.dispose()
  vi.restoreAllMocks()
})

describe('layout configuration execution boundary', () => {
  it('keeps mixed declarations out of CSSOM reads, writes and native keyframes', () => {
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    const reads = vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue')
    const source: Definition = {
      ...compiled,
      layers: compiled.layers.map((layer) =>
        layer.name !== 'active'
          ? layer
          : {
              ...layer,
              targets: layer.targets.map((target) => ({
                ...target,
                properties: [
                  ...target.properties,
                  {
                    name: 'opacity',
                    value: { kind: 'literal', value: '0.5' },
                    timing: { kind: 'tween', durationMs: 500, easing: 'linear' },
                  },
                ],
              })),
            },
      ),
    }
    const { assembly, errors } = harness.setup(source, { active: false, duration: 150 })

    assembly.runtime.updateParameters({ active: true, duration: 150 })

    const frames = nativeEffects(assembly.executor).flatMap((animation) => {
      if (!(animation.effect instanceof KeyframeEffect))
        throw new Error('Expected native keyframes')

      return animation.effect.getKeyframes()
    })

    expect(frames.some((frame) => 'opacity' in frame)).toBe(true)
    expect(frames.every((frame) => !('$layout' in frame))).toBe(true)
    expect(writes.mock.calls.every(([name]) => name !== '$layout')).toBe(true)
    expect(reads.mock.calls.every(([name]) => name !== '$layout')).toBe(true)
    expect(assembly.runtime.layout.find((entry) => entry.target === 'self')?.axes).toEqual({
      x: true,
      y: true,
      width: false,
      height: false,
    })
    expect(errors).toEqual([])
  })

  it('inspects axes, timing and provenance without adding editable layout CSS tracks', () => {
    const { assembly, errors } = harness.setup(compiled, { active: false, duration: 150 })
    const before = assembly.runtime.composition
    const result = assembly.inspection.inspectComposition({
      layers: { base: true, active: true },
      states: { phase: 'off' },
    })
    const root = result.layout?.find((entry) => entry.target === 'self')

    expect(root).toMatchObject({
      axes: { x: true, y: true, width: false, height: false },
      timing: { kind: 'tween', durationMs: 0 },
      source: { layer: 'active', target: 'self' },
      timingSource: { layer: 'active', property: '$layout' },
    })
    expect(
      result.presentation.targets
        .flatMap((target) => target.properties)
        .every((property) => property.name !== '$layout'),
    ).toBe(true)
    expect(assembly.runtime.composition).toEqual(before)
    expect(errors).toEqual([])
  })

  it('requires named targets that contain only layout configuration', () => {
    const { assembly, targets, errors } = harness.setup(compiled, { active: false, duration: 150 })
    const root = targets.get('self')

    if (!root) throw new Error('Expected the bound root')

    assembly.executor.bind([['self', root]])

    expect(assembly.executor.bindingFacts.suspended).toBe(true)
    expect(errors.some((error) => error.code === 'runtime.targets')).toBe(true)
  })
})
