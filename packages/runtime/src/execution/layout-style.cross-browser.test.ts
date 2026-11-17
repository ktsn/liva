import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { nativeEffects, type RuntimeAssembly } from '../__test__/helpers/assembly.ts'
import type { Definition } from '../model/definition.ts'
import { observeLayoutStyles } from '../layout/style-observation.ts'
import { layoutRadiusProperties } from '../layout/style-properties.ts'
import type { ProjectionMatrix } from '../layout/projection.ts'

const harness = createBrowserRuntimeHarness()
const distortion = { a: 0.5, b: 0, c: 0, d: 0.25, e: 0, f: 0 }

function definition(): Definition {
  return {
    name: 'paint',
    parameters: [
      { name: 'active', type: 'boolean' },
      { name: 'radius', type: 'string' },
      { name: 'shadow', type: 'string' },
    ],
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'self',
            properties: [
              {
                kind: 'layout',
                name: '$layout',
                axes: { x: true, y: true, width: true, height: true },
              },
            ],
          },
        ],
      },
      {
        name: 'active',
        when: { kind: 'reference', path: ['active'] },
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'self',
            properties: ['border-radius', 'box-shadow'].map((name) => ({
              name,
              value: {
                kind: 'template',
                parts: [
                  { kind: 'reference', path: [name === 'border-radius' ? 'radius' : 'shadow'] },
                ],
              },
            })),
          },
        ],
      },
    ],
  }
}

function setup() {
  const result = harness.setup(definition(), {
    active: false,
    radius: '24px',
    shadow: 'rgb(60, 80, 100) 6px 8px 12px 3px',
  })
  const root = result.targets.get('self')!
  root.style.cssText = 'width:200px;height:100px;'
  const sheet = document.createElement('style')
  sheet.textContent = '.paint-source {border-radius:8px;box-shadow:rgb(0,0,0) 2px 4px 6px 1px;}'
  harness.append(sheet)
  root.className = 'paint-source'

  return { ...result, root }
}

function project(
  assembly: RuntimeAssembly,
  element: HTMLElement,
  matrix: ProjectionMatrix = distortion,
  transform = `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},0,0)`,
) {
  const observation = assembly.executor.layoutStyleObservation(element, 200, 100)
  if (observation) observeLayoutStyles([observation.element], () => observation.read())

  assembly.executor.layoutTransform(element, transform, undefined, {
    width: 200,
    height: 100,
    distortion: matrix,
  })
}

function update(assembly: RuntimeAssembly, active: boolean, radius = '24px') {
  assembly.runtime.updateParameters({ active, radius, shadow: 'rgb(60, 80, 100) 6px 8px 12px 3px' })
}

function paused(assembly: RuntimeAssembly, time: number) {
  const effects = nativeEffects(assembly.executor)
  for (const animation of effects) {
    animation.pause()
    animation.currentTime = time
  }

  return effects
}

function keyframes(animation: Animation) {
  if (!(animation.effect instanceof KeyframeEffect)) throw new Error('Expected authored keyframes')

  return animation.effect.getKeyframes()
}

function values(element: HTMLElement) {
  const style = getComputedStyle(element)
  return [...layoutRadiusProperties, 'box-shadow'].map((property) =>
    style.getPropertyValue(property),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  harness.dispose()
})

describe('Executor layout paint correction', () => {
  it('corrects unequal-axis CSS corners and shadows once from the retained source', () => {
    const { assembly, root, errors } = setup()
    root.style.borderRadius = '12px 18px 24px 30px / 16px 20px 26px 32px'

    project(assembly, root)

    expect(values(root).slice(0, 4)).toEqual(['24px 64px', '36px 80px', '48px 104px', '60px 128px'])
    const style = getComputedStyle(root)
    expect(style.boxShadow).toContain('4px 16px')
    const read = vi.spyOn(window, 'getComputedStyle')
    const rect = vi.spyOn(root, 'getBoundingClientRect')

    for (let frame = 0; frame < 10; frame++) project(assembly, root)

    expect(read).not.toHaveBeenCalled()
    expect(rect).not.toHaveBeenCalled()
    read.mockRestore()
    expect(values(root).slice(0, 4)).toEqual(['24px 64px', '36px 80px', '48px 104px', '60px 128px'])
    assembly.executor.layoutCleanup()
    expect(root.style.borderRadius).toBe('12px 18px 24px 30px / 16px 20px 26px 32px')
    expect(root.getAnimations()).toEqual([])
    expect(errors).toEqual([])
  })

  it('decodes percentage and mixed radii in the natural destination basis', () => {
    const { assembly, root } = setup()
    root.style.width = '120px'
    root.style.height = '60px'
    root.style.borderRadius = '1% 2% 3% 4% / calc(1% + 1px) 2% 3% 4%'
    root.style.boxShadow = 'none'

    project(assembly, root)

    expect(values(root)).toEqual(['4px 8px', '8px', '12px', '16px', 'none'])
    assembly.executor.layoutCleanup()
    expect(root.style.width).toBe('120px')
    expect(root.style.height).toBe('60px')
  })

  it('uses the full inverse affine offset and retains multiple inset/color layers', () => {
    const { assembly, root } = setup()
    root.style.color = 'rgb(60, 80, 100)'
    root.style.setProperty('--shadow-color', 'rgb(20 40 60 / .5)')
    root.style.boxShadow =
      '4px 6px 7px 2px var(--shadow-color), inset -2px 5px 0px -1px currentColor'
    root.style.borderRadius = '0'
    const authoredShadow = root.style.boxShadow
    const native = document.createElement('div')
    native.style.boxShadow =
      'rgba(20,40,60,.5) 2px 10px 7px 2px, inset rgb(60,80,100) -1px 11px 0px -1px'
    harness.append(native)

    project(assembly, root, { a: 2, b: 0.5, c: 0, d: 0.5, e: 0, f: 0 })

    expect(getComputedStyle(root).boxShadow).toBe(getComputedStyle(native).boxShadow)
    expect(values(root).slice(0, 4)).toEqual(['0px', '0px', '0px', '0px'])
    project(assembly, root)
    project(assembly, root, { a: 2, b: 0.5, c: 0, d: 0.5, e: 0, f: 0 })
    expect(getComputedStyle(root).boxShadow).toBe(getComputedStyle(native).boxShadow)
    assembly.executor.layoutCleanup()
    expect(root.style.boxShadow).toContain('var(--shadow-color)')
    expect(root.style.boxShadow).toBe(authoredShadow)
  })

  it('retains valid projection and shadow correction when native radius syntax cannot be decoded', () => {
    const { assembly, root } = setup()
    root.style.borderRadius = 'round(nearest, 20%, 3px)'
    const authoredRadius = root.style.borderRadius
    expect(CSS.supports('border-radius', 'round(nearest, 20%, 3px)')).toBe(true)

    project(assembly, root)

    expect(root.style.transform).toBe('matrix(0.5, 0, 0, 0.25, 0, 0)')
    expect(root.style.borderRadius).toBe(authoredRadius)
    expect(root.style.getPropertyPriority('border-top-left-radius')).toBe('')
    expect(getComputedStyle(root).boxShadow).toContain('4px 16px')
    const output = root
      .getAnimations()
      .find((animation) => animation.effect?.getTiming().duration === 1)
    if (!output) throw new Error('Expected retained native projection guard')

    expect(keyframes(output).every((frame) => !('borderTopLeftRadius' in frame))).toBe(true)
    root.style.borderRadius = '6px'
    // A new source interval observes the recovered native syntax without changing box support.
    assembly.executor.layoutCleanup()
    project(assembly, root)
    expect(getComputedStyle(root).borderTopLeftRadius).toBe('12px 24px')
  })

  it('keeps new ordinary effects based on uncorrected CSS through enable, retarget and removal', () => {
    const actual = setup()
    const source = setup()
    project(actual.assembly, actual.root)

    for (const { assembly } of [actual, source]) update(assembly, true)
    const initial = paused(actual.assembly, 250)
    paused(source.assembly, 250)
    project(actual.assembly, actual.root)

    const radius = initial.find((animation) => 'borderRadius' in keyframes(animation)[0])
    if (!radius) throw new Error('Expected authored radius effect')

    expect(keyframes(radius)[0].borderRadius).toBe('8px')
    const receiver = actual.assembly.executor.presentationFacts().receivers[0].id
    const observed = actual.assembly.executor.observeDisplayed([
      { receiver, property: 'border-radius' },
      { receiver, property: 'box-shadow' },
    ])
    expect(observed.map(({ value }) => value)).toEqual([
      getComputedStyle(source.root).borderRadius,
      getComputedStyle(source.root).boxShadow,
    ])
    expect(getComputedStyle(actual.root).borderTopLeftRadius).toBe('24px 48px')
    expect(nativeEffects(actual.assembly.executor)).toEqual(initial)
    expect(
      initial.every(
        (animation) => animation.currentTime === 250 && animation.playState === 'paused',
      ),
    ).toBe(true)

    for (const { assembly } of [actual, source]) update(assembly, true, '40px')
    const retargeted = paused(actual.assembly, 0)
    paused(source.assembly, 0)
    project(actual.assembly, actual.root)

    const next = retargeted.find((animation) => 'borderRadius' in keyframes(animation)[0])
    if (!next) throw new Error('Expected retargeted radius effect')
    expect(keyframes(next)[0].borderRadius).toBe('12px')
    expect(getComputedStyle(actual.root).borderTopLeftRadius).toBe('24px 48px')

    for (const { assembly } of [actual, source]) update(assembly, false)
    project(actual.assembly, actual.root)

    expect(getComputedStyle(actual.root).borderTopLeftRadius).toBe('16px 32px')
    actual.assembly.executor.layoutCleanup()
    expect(values(actual.root)).toEqual(values(source.root))
    expect(actual.root.style.borderRadius).toBe('')
    expect(actual.root.style.boxShadow).toBe('')
    expect(actual.root.getAnimations()).toEqual([])
    expect(actual.errors).toEqual([])
  })

  it('samples a running authored clock without seeking, replacing or canceling its effects', async () => {
    const actual = setup()
    const source = setup()
    for (const { assembly } of [actual, source]) update(assembly, true)
    const effects = nativeEffects(actual.assembly.executor)
    const all = [...effects, ...nativeEffects(source.assembly.executor)]
    await Promise.all(all.map((animation) => animation.ready))
    const start = Number(document.timeline.currentTime) - 250
    for (const animation of all) animation.startTime = start
    const before = effects.map((animation) => ({
      animation,
      effect: animation.effect,
      frames: keyframes(animation),
      time: animation.currentTime,
    }))

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    project(actual.assembly, actual.root)

    const baseline = Number.parseFloat(getComputedStyle(source.root).borderTopLeftRadius)
    const expected = document.createElement('div')
    expected.style.borderTopLeftRadius = `${baseline * 2}px ${baseline * 4}px`
    harness.append(expected)
    expect(getComputedStyle(actual.root).borderTopLeftRadius).toBe(
      getComputedStyle(expected).borderTopLeftRadius,
    )
    expect(nativeEffects(actual.assembly.executor)).toEqual(effects)
    for (const entry of before) {
      expect(entry.animation.effect).toBe(entry.effect)
      expect(keyframes(entry.animation)).toEqual(entry.frames)
      expect(entry.animation.currentTime).toBeGreaterThan(Number(entry.time))
      expect(entry.animation.playState).toBe('running')
    }
    expect(actual.errors).toEqual([])
  })

  it('restores a current important shorthand/corner cascade while retaining fixed geometry', () => {
    const actual = setup()
    const source = setup()
    const constraints = new Map([
      ['padding-inline-end', '20px'],
      ['min-inline-size', '200px'],
      ['max-inline-size', '200px'],
    ] as const)
    project(actual.assembly, actual.root)
    actual.assembly.executor.layoutTransform(actual.root, 'scale(.5,.25)', constraints)
    const before = actual.root.getBoundingClientRect()

    for (const { root } of [actual, source]) {
      root.style.setProperty('border-radius', '14px 18px / 20px 24px', 'important')
      root.style.setProperty('border-top-left-radius', '22px 28px', 'important')
      root.style.setProperty('box-shadow', 'inset rgb(20, 40, 60) -3px 5px 0px -1px', 'important')
    }
    const receiver = actual.assembly.executor.presentationFacts().receivers[0].id
    const observed = actual.assembly.executor.observeDisplayed([
      { receiver, property: 'border-radius' },
      { receiver, property: 'box-shadow' },
    ])

    expect(observed.map(({ value }) => value)).toEqual([
      getComputedStyle(source.root).borderRadius,
      getComputedStyle(source.root).boxShadow,
    ])
    expect(actual.root.getBoundingClientRect().width).toBe(before.width)
    expect(actual.root.style.minInlineSize).toBe('200px')
    expect(actual.root.style.paddingInlineEnd).toBe('20px')
    actual.assembly.executor.layoutCleanup()
    expect(values(actual.root)).toEqual(values(source.root))
    expect(actual.root.style.getPropertyPriority('border-top-left-radius')).toBe('important')
    expect(actual.root.getAnimations()).toEqual([])
  })

  it.each([false, true])(
    'samples inherited source paint across runtimes with projected parent %s',
    async (projectParent) => {
      const parent = setup()
      const child = setup()
      parent.root.append(child.root)
      child.root.style.borderRadius = 'inherit'
      child.root.style.boxShadow = 'inherit'
      const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
      const transform = projectParent ? 'scale(2,4)' : 'none'
      if (projectParent) project(parent.assembly, parent.root)

      project(child.assembly, child.root, identity, transform)

      expect(getComputedStyle(child.root).borderTopLeftRadius).toBe('8px')
      expect(getComputedStyle(child.root).boxShadow).toBe('rgb(0, 0, 0) 2px 4px 6px 1px')
      update(parent.assembly, true)
      const effects = paused(parent.assembly, 250)
      if (projectParent) project(parent.assembly, parent.root)
      project(child.assembly, child.root, identity, transform)
      expect(getComputedStyle(child.root).borderTopLeftRadius).toBe('12px')

      for (const animation of effects) animation.currentTime = 500
      if (projectParent) project(parent.assembly, parent.root)
      project(child.assembly, child.root, identity, transform)

      expect(getComputedStyle(child.root).borderTopLeftRadius).toBe('16px')
      expect(nativeEffects(parent.assembly.executor)).toEqual(effects)
      expect(
        effects.every(
          (animation) => animation.currentTime === 500 && animation.playState === 'paused',
        ),
      ).toBe(true)
      for (const animation of effects) animation.finish()
      await Promise.all(effects.map((animation) => animation.finished))
      await Promise.resolve()
      if (projectParent) project(parent.assembly, parent.root)
      project(child.assembly, child.root, identity, transform)
      expect(getComputedStyle(child.root).borderTopLeftRadius).toBe('24px')

      update(parent.assembly, false)
      project(child.assembly, child.root, identity, transform)
      expect(getComputedStyle(child.root).borderTopLeftRadius).toBe('8px')

      child.assembly.executor.layoutCleanup()
      parent.assembly.executor.layoutCleanup()
      expect(child.root.style.borderRadius).toBe('inherit')
      expect(child.root.style.boxShadow).toBe('inherit')
    },
  )

  it('reuses a paused source until its native clock changes without a Vue update', () => {
    const { assembly, root } = setup()
    update(assembly, true)
    const effects = paused(assembly, 250)
    project(assembly, root)
    const read = vi.spyOn(window, 'getComputedStyle')

    for (let frame = 0; frame < 10; frame++) project(assembly, root)

    expect(read).not.toHaveBeenCalled()
    for (const animation of effects) animation.currentTime = 500
    project(assembly, root)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRestore()
    expect(getComputedStyle(root).borderTopLeftRadius).toBe('32px 64px')
    expect(nativeEffects(assembly.executor)).toEqual(effects)
  })

  it('restores earlier owners when later native paint preparation throws', () => {
    const owners = [setup(), setup()]
    for (const { assembly, root } of owners) {
      update(assembly, true)
      paused(assembly, 250)
      project(assembly, root)
    }
    const before = owners.map(({ root }) => values(root))
    const output = owners[1].root
      .getAnimations()
      .find((animation) => animation.effect?.getTiming().duration === 1)
    if (!output || !(output.effect instanceof KeyframeEffect))
      throw new Error('Expected native layout guard')
    const cause = new Error('Later native source exclusion failed')
    vi.spyOn(output.effect, 'setKeyframes').mockImplementationOnce(() => {
      throw cause
    })
    for (const { assembly } of owners)
      for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 500
    const observations = owners.map(({ assembly, root }) =>
      assembly.executor.layoutStyleObservation(root, 200, 100),
    )
    if (observations.some((observation) => !observation))
      throw new Error('Expected active source observations')
    const active = observations.filter((observation) => observation !== undefined)

    expect(() =>
      observeLayoutStyles(
        active.map((observation) => observation.element),
        () => {
          for (const observation of active) observation.read()
        },
      ),
    ).toThrow(cause)

    expect(owners.map(({ root }) => values(root))).toEqual(before)
    for (const { assembly, root } of owners) {
      project(assembly, root)
      expect(root.getAnimations()).toHaveLength(3)
    }
  })

  it('does not reinstall an obsolete paint observation after Runtime disposal', () => {
    const { assembly, root } = setup()
    update(assembly, true)
    paused(assembly, 250)
    project(assembly, root)
    for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 500
    const observation = assembly.executor.layoutStyleObservation(root, 200, 100)
    if (!observation) throw new Error('Expected active source observation')
    observeLayoutStyles([observation.element], () => {
      assembly.runtime.dispose()
    })

    expect(root.style.transform).toBe('')
    expect(root.style.borderRadius).toBe('')
    expect(root.getAnimations()).toEqual([])
  })

  it('restores every acquired paint owner after a source read throws and permits retry', () => {
    const { assembly, root } = setup()
    update(assembly, true)
    const effects = paused(assembly, 250)
    project(assembly, root)
    const before = values(root)
    for (const animation of effects) animation.currentTime = 500
    const cause = new Error('Underlying paint read failed')
    const read = window.getComputedStyle.bind(window)
    const fail = vi.spyOn(window, 'getComputedStyle').mockImplementationOnce((element) => {
      if (element === root) throw cause
      return read(element)
    })

    expect(() => project(assembly, root)).toThrow(cause)

    expect(values(root)).toEqual(before)
    expect(nativeEffects(assembly.executor)).toEqual(effects)
    expect(
      effects.every(
        (animation) => animation.currentTime === 500 && animation.playState === 'paused',
      ),
    ).toBe(true)
    fail.mockRestore()
    project(assembly, root)
    expect(getComputedStyle(root).borderTopLeftRadius).toBe('32px 64px')
    assembly.executor.layoutCleanup()
    expect(root.style.borderRadius).toBe('24px')
  })
})
