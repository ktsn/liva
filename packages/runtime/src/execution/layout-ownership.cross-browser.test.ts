import { batchLayoutWrites } from '../layout/layout-write-phase.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { nativeEffects } from '../__test__/helpers/assembly.ts'
import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import { PresenceOperation } from './presence-operation.ts'
import type { Definition as PropertyIRDefinition } from '../model/definition.ts'

const harness = createBrowserRuntimeHarness()
afterEach(() => harness.dispose())

function setup(source: PropertyIRDefinition, inputs: Record<string, unknown>) {
  return harness.setup(source, inputs)
}

const layoutAxes = { x: true, y: true, width: true, height: true } as const

function layoutDefinition(): PropertyIRDefinition {
  return {
    name: 'layout',
    parameters: [{ name: 'active', type: 'boolean' }],
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
                axes: layoutAxes,
                timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
              },
            ],
          },
        ],
      },
      {
        name: 'active',
        when: { kind: 'reference', path: ['active'] },
        targets: [
          {
            name: 'self',
            properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.5' } }],
          },
        ],
      },
    ],
  }
}

function computedProperties(element: HTMLElement, properties: readonly string[]) {
  const style = getComputedStyle(element)
  return properties.map((property) => style.getPropertyValue(property))
}

describe('Executor temporary layout ownership', () => {
  it('rebases temporary important output through the ordinary style writer and preserves current inline CSS', () => {
    const { assembly, targets, errors } = setup(layoutDefinition(), { active: true })
    const root = targets.get('self')!
    root.style.setProperty('transform', 'rotate(20deg)', 'important')
    root.style.width = '100px'
    assembly.executor.layoutTransform(root, 'matrix(.5, 0, 0, .5, 0, 0)')

    expect(root.style.getPropertyPriority('transform')).toBe('important')
    root.style.setProperty('transform', 'rotate(35deg)', 'important')
    root.style.width = '200px'
    assembly.executor.layoutTransform(root, 'matrix(.75, 0, 0, .75, 0, 0)')
    assembly.runtime.updateParameters({ active: false })
    expect(root.style.transform.startsWith('matrix(')).toBe(true)

    assembly.executor.layoutTransform(root, undefined)

    expect(root.style.transform).toBe('rotate(35deg)')
    expect(root.style.getPropertyPriority('transform')).toBe('important')
    expect(root.style.width).toBe('200px')
    expect(errors).toEqual([])
  })

  it('materializes every target transition only after all owners finish their writes', () => {
    const owners = [
      setup(layoutDefinition(), { active: false }),
      setup(layoutDefinition(), { active: false }),
    ]
    const elements = owners.map(({ targets }) => targets.get('self')!)
    const events: string[] = []
    const reads = elements.map((element, index) => {
      const read = element.getAnimations.bind(element)
      return vi.spyOn(element, 'getAnimations').mockImplementation(() => {
        events.push(`read${index}`)
        return read()
      })
    })

    batchLayoutWrites(() => {
      for (const [index, { assembly }] of owners.entries()) {
        assembly.executor.layoutTransform(elements[index], 'scale(.5)')
        events.push(`write${index}`)
      }
    })

    expect(events).toEqual(['write0', 'write1', 'read0', 'read1'])
    for (const read of reads) read.mockRestore()
    expect(elements.every((element) => element.getAnimations().length === 1)).toBe(true)
  })

  it('keeps a reacquired native output when release and reacquisition share a write phase', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.transform = 'rotate(20deg)'
    assembly.executor.layoutTransform(root, 'scale(.5)')
    const output = root.getAnimations()[0]

    batchLayoutWrites(() => {
      assembly.executor.layoutTransform(root, undefined)
      assembly.executor.layoutTransform(root, undefined)
      assembly.executor.layoutTransform(root, 'scale(.75)')
    })

    expect(root.getAnimations()).toEqual([output])
    expect(output.playState).toBe('paused')
    expect(getComputedStyle(root).transform).toBe('matrix(0.75, 0, 0, 0.75, 0, 0)')
    assembly.executor.layoutCleanup()
    expect(root.getAnimations()).toEqual([])
    expect(root.style.transform).toBe('rotate(20deg)')
  })

  it('preserves a write failure and still attempts independent native cleanup reads', () => {
    const owners = [
      setup(layoutDefinition(), { active: false }),
      setup(layoutDefinition(), { active: false }),
    ]
    const elements = owners.map(({ targets }) => targets.get('self')!)
    for (const [index, { assembly }] of owners.entries())
      assembly.executor.layoutTransform(elements[index], 'scale(.5)')
    const cause = new Error('Projection write failed')
    const readCause = new Error('Transition materialization failed')
    const failed = vi.spyOn(elements[0], 'getAnimations').mockImplementationOnce(() => {
      throw readCause
    })
    const independent = vi.spyOn(elements[1], 'getAnimations')

    expect(() =>
      batchLayoutWrites(() => {
        for (const [index, { assembly }] of owners.entries())
          assembly.executor.layoutTransform(elements[index], undefined)
        throw cause
      }),
    ).toThrow(
      expect.objectContaining({ cause, errors: expect.arrayContaining([cause, readCause]) }),
    )

    expect(independent).toHaveBeenCalledTimes(1)
    failed.mockRestore()
    independent.mockRestore()
    for (const { assembly } of owners) assembly.executor.layoutCleanup()
    expect(
      elements.every(
        (element) => element.getAnimations().length === 0 && element.style.transform === '',
      ),
    ).toBe(true)
  })

  it('owns fixed logical constraints with the transform and releases to current important CSS', () => {
    const { assembly, targets, errors } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText =
      'width:400px;height:100px;min-inline-size:80px!important;max-inline-size:500px!important;transition:all 1000ms linear;'
    const constraints = new Map([
      ['min-inline-size', '200px'],
      ['max-inline-size', '200px'],
    ] as const)

    assembly.executor.layoutTransform(root, 'scale(.5)', constraints)
    expect(getComputedStyle(root).width).toBe('200px')
    root.style.setProperty('max-inline-size', '300px', 'important')
    assembly.executor.layoutTransform(
      root,
      'scale(.75)',
      new Map([
        ['min-inline-size', '250px'],
        ['max-inline-size', '250px'],
      ]),
    )
    expect(getComputedStyle(root).width).toBe('250px')
    assembly.executor.layoutCleanup()

    expect(root.style.minInlineSize).toBe('80px')
    expect(root.style.maxInlineSize).toBe('300px')
    expect(root.style.getPropertyPriority('max-inline-size')).toBe('important')
    expect(getComputedStyle(root).width).toBe('300px')
    expect(root.style.width).toBe('400px')
    expect(root.style.height).toBe('100px')
    expect(root.getAnimations()).toEqual([])
    expect(errors).toEqual([])
  })

  it.each(['horizontal-tb', 'vertical-rl'])(
    'orders fixed logical constraints after important physical aliases in %s',
    (writingMode) => {
      const { assembly, targets } = setup(layoutDefinition(), { active: false })
      const root = targets.get('self')!
      root.style.cssText = `width:400px;height:400px;writing-mode:${writingMode};min-inline-size:80px!important;max-inline-size:500px!important;min-width:100px!important;max-width:450px!important;min-height:100px!important;max-height:450px!important;transition:all 1000ms linear;`

      assembly.executor.layoutTransform(
        root,
        'scale(.5)',
        new Map([
          ['min-inline-size', '200px'],
          ['max-inline-size', '200px'],
        ]),
      )

      expect(getComputedStyle(root).inlineSize).toBe('200px')
      expect(getComputedStyle(root).blockSize).toBe('400px')
      assembly.executor.layoutCleanup()
      expect(getComputedStyle(root).inlineSize).toBe('400px')
      expect(getComputedStyle(root).blockSize).toBe('400px')
      expect(root.style.minInlineSize).toBe('80px')
      expect(root.style.maxInlineSize).toBe('500px')
      expect(root.getAnimations()).toEqual([])
    },
  )

  it('releases previously owned physical constraint transitions after a writing-mode change', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText =
      'width:400px;height:400px;writing-mode:horizontal-tb;min-width:100px!important;max-width:450px!important;min-height:100px!important;max-height:450px!important;transition:all 1000ms linear;'
    assembly.executor.layoutTransform(
      root,
      'scale(.5)',
      new Map([
        ['min-inline-size', '200px'],
        ['max-inline-size', '200px'],
      ]),
    )
    expect(getComputedStyle(root).width).toBe('200px')

    root.style.writingMode = 'vertical-rl'
    assembly.executor.layoutCleanup()

    expect(getComputedStyle(root).width).toBe('400px')
    expect(getComputedStyle(root).height).toBe('400px')
    expect(root.getAnimations()).toEqual([])
    expect(root.style.writingMode).toBe('vertical-rl')
  })

  it('restores a current important padding shorthand after logical padding stabilization', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText =
      'width:200px;height:100px;padding:5%!important;transition:all 1000ms linear;'
    const constraints = new Map([
      ['padding-inline-start', '20px'],
      ['padding-inline-end', '20px'],
      ['padding-block-start', '20px'],
      ['padding-block-end', '20px'],
    ] as const)
    assembly.executor.layoutTransform(root, 'scale(.5)', constraints)
    expect(getComputedStyle(root).paddingTop).toBe('20px')

    root.style.setProperty('padding', '10%', 'important')
    assembly.executor.layoutCleanup()

    expect(root.style.padding).toBe('10%')
    expect(root.style.getPropertyPriority('padding')).toBe('important')
    expect(root.style.paddingInlineStart).toBe('')
    expect(root.style.paddingInlineEnd).toBe('')
    expect(root.style.paddingBlockStart).toBe('')
    expect(root.style.paddingBlockEnd).toBe('')
    expect(root.getAnimations()).toEqual([])
  })

  it.each(
    [false, true].flatMap((logicalFirst) =>
      ['horizontal-tb', 'vertical-rl'].flatMap((writingMode) =>
        [false, true].map((variable) => ({ logicalFirst, writingMode, variable })),
      ),
    ),
  )(
    'preserves the native order of external shorthand and logical declarations: %j',
    ({ logicalFirst, writingMode, variable }) => {
      const { assembly, targets } = setup(layoutDefinition(), { active: false })
      const root = targets.get('self')!
      root.style.cssText = 'width:200px;height:100px;writing-mode:horizontal-tb;--padding:9% 4%;'
      const native = document.createElement('div')
      native.style.cssText = root.style.cssText
      harness.append(native)
      const constraints = new Map([
        ['padding-inline-start', '20px'],
        ['padding-inline-end', '20px'],
        ['padding-block-start', '20px'],
        ['padding-block-end', '20px'],
      ] as const)
      assembly.executor.layoutTransform(root, 'scale(.5)', constraints)
      const apply = (element: HTMLElement) => {
        element.style.writingMode = writingMode
        const shorthand = () =>
          element.style.setProperty('padding', variable ? 'var(--padding)' : '9% 4%', 'important')
        const logical = () => element.style.setProperty('padding-inline-end', '7%', 'important')
        for (const write of logicalFirst ? [logical, shorthand] : [shorthand, logical]) write()
        element.style.setProperty('min-width', '160px', 'important')
        element.style.setProperty(
          '--opaque',
          `[one;two] {a:b;c:d} "quoted;colon:!important" 'single;quote' a/* s*e;: */b / c`,
        )
        element.style.setProperty('--escaped', '"quote\\\";colon:"')
      }

      apply(root)
      apply(native)
      assembly.executor.layoutCleanup()

      const properties = [
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        'min-width',
      ]
      expect(computedProperties(root, properties)).toEqual(computedProperties(native, properties))
      expect(root.style.paddingInlineEnd).toBe(native.style.paddingInlineEnd)
      expect(root.style.getPropertyValue('--opaque')).toBe(
        native.style.getPropertyValue('--opaque'),
      )
      expect(root.style.getPropertyValue('--escaped')).toBe(
        native.style.getPropertyValue('--escaped'),
      )
      expect(root.style.getPropertyPriority('padding-inline-end')).toBe('important')
      expect(root.getAnimations()).toEqual([])
    },
  )

  it.each(['remove', 'attribute', 'clear', 'remove-attribute'] as const)(
    'retains authored deletion and explicit declaration order during %s updates',
    (mode) => {
      const { assembly, targets } = setup(layoutDefinition(), { active: false })
      const root = targets.get('self')!
      root.style.cssText =
        'width:200px;height:100px;color:red;padding:5%;padding-inline-end:8%!important;'
      const native = document.createElement('div')
      native.style.cssText = root.style.cssText
      harness.append(native)
      assembly.executor.layoutTransform(
        root,
        'scale(.5)',
        new Map([['padding-inline-end', '20px']]),
      )
      const apply = (element: HTMLElement) => {
        if (mode === 'remove') element.style.removeProperty('padding-inline-end')
        else if (mode === 'attribute')
          element.setAttribute(
            'style',
            'padding-inline-end:7%!important;padding:9% 4%!important;color:blue;width:200px;height:100px;',
          )
        else if (mode === 'clear') element.style.cssText = ''
        else element.removeAttribute('style')
      }

      apply(root)
      apply(native)
      assembly.executor.layoutCleanup()

      const properties = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color']
      expect(computedProperties(root, properties)).toEqual(computedProperties(native, properties))
      expect(root.style.paddingInlineEnd).toBe(native.style.paddingInlineEnd)
      expect(root.getAnimations()).toEqual([])
    },
  )

  it('keeps unchanged hidden declarations anchored when cssText moves an unrelated property', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText =
      'color:red!important;padding-inline-end:8%!important;all:initial!important;display:block!important;width:200px!important;height:100px!important;'
    const native = document.createElement('div')
    native.style.cssText = root.style.cssText
    harness.append(native)
    assembly.executor.layoutTransform(root, 'scale(.5)', new Map([['padding-inline-end', '20px']]))

    root.style.cssText += ';color:green!important;'
    native.style.cssText += ';color:green!important;'
    assembly.executor.layoutCleanup()

    const properties = ['padding-right', 'color', 'width', 'height']
    expect(computedProperties(root, properties)).toEqual(computedProperties(native, properties))
    expect(root.getAnimations()).toEqual([])
  })

  it('retains a logical var shorthand through an unrelated serialized style update', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText =
      'color:red;--pair:8% 6%;padding-inline:var(--pair)!important;width:200px;height:100px;'
    const native = document.createElement('div')
    native.style.cssText = root.style.cssText
    harness.append(native)
    assembly.executor.layoutTransform(
      root,
      'scale(.5)',
      new Map([
        ['padding-inline-start', '20px'],
        ['padding-inline-end', '20px'],
      ]),
    )

    for (const element of [root, native]) {
      element.style.setProperty('padding-inline-end', '7%', 'important')
      element.style.cssText += ';color:green;'
    }
    assembly.executor.layoutCleanup()

    const properties = ['padding-left', 'padding-right', 'color']
    expect(computedProperties(root, properties)).toEqual(computedProperties(native, properties))
    expect(root.style.getPropertyValue('--pair')).toBe(native.style.getPropertyValue('--pair'))
    expect(root.getAnimations()).toEqual([])
  })

  it('retries an ordered source replay after a native metadata failure without losing edits', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText = 'width:200px;height:100px;'
    const native = document.createElement('div')
    native.style.cssText = root.style.cssText
    harness.append(native)
    assembly.executor.layoutTransform(root, 'scale(.5)', new Map([['padding-inline-end', '20px']]))
    for (const element of [root, native]) {
      element.style.setProperty('padding', '9% 4%', 'important')
      element.style.setProperty('padding-inline-end', '7%', 'important')
    }
    const cause = new Error('Native source replay failed once')
    // Retain the native method only for explicit .call(this) below.
    // eslint-disable-next-line typescript/unbound-method
    const set = CSSStyleDeclaration.prototype.setProperty
    let failed = false
    const fail = vi
      .spyOn(CSSStyleDeclaration.prototype, 'setProperty')
      .mockImplementation(function (this: CSSStyleDeclaration, property, value, priority) {
        if (
          !failed &&
          this !== root.style &&
          this !== native.style &&
          property === 'padding-inline-end' &&
          value === '7%'
        ) {
          failed = true
          throw cause
        }
        set.call(this, property, value, priority)
      })

    expect(() => assembly.executor.layoutCleanup()).toThrow(cause)
    assembly.executor.layoutCleanup()

    expect(failed).toBe(true)
    expect(computedProperties(root, ['padding-left', 'padding-right'])).toEqual(
      computedProperties(native, ['padding-left', 'padding-right']),
    )
    expect(root.getAnimations()).toEqual([])
    fail.mockRestore()
  })

  it('keeps a fresh style owner after batched release, constraint change and another release', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText = 'width:200px;height:100px;'
    const native = document.createElement('div')
    native.style.cssText = root.style.cssText
    harness.append(native)
    batchLayoutWrites(() => {
      assembly.executor.layoutTransform(
        root,
        'scale(.5)',
        new Map([['padding-inline-end', '20px']]),
      )
      assembly.executor.layoutTransform(root, undefined)
      assembly.executor.layoutTransform(
        root,
        'scale(.75)',
        new Map([['padding-inline-end', '30px']]),
      )
      assembly.executor.layoutTransform(root, undefined)
    })
    assembly.executor.layoutTransform(root, 'scale(.5)', new Map([['padding-inline-end', '20px']]))

    for (const element of [root, native]) {
      element.style.setProperty('padding', '9% 4%', 'important')
      element.style.setProperty('padding-inline-end', '7%', 'important')
    }
    assembly.executor.layoutCleanup()

    expect(computedProperties(root, ['padding-left', 'padding-right'])).toEqual(
      computedProperties(native, ['padding-left', 'padding-right']),
    )
    expect(root.style.transform).toBe('')
    expect(root.getAnimations()).toEqual([])
  })

  it('retains detached external edits when a remaining native owner is released', async () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.cssText = 'width:200px;height:100px;color:red;'
    assembly.executor.layoutTransform(root, 'scale(.5)')
    const output = root.getAnimations()[0]
    root.remove()
    await Promise.resolve()
    await Promise.resolve()

    root.style.color = 'purple'
    assembly.executor.layoutCleanup()

    expect(root.style.color).toBe('purple')
    expect(root.style.transform).toBe('')
    expect(output.playState).toBe('idle')
  })

  it('does not adopt a generated declaration when its native setter throws after writing', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    root.style.transform = 'rotate(20deg)'
    const cause = new Error('Native generated write failed after applying')
    const set = root.style.setProperty.bind(root.style)
    const fail = vi.spyOn(root.style, 'setProperty').mockImplementationOnce((...args) => {
      set(...args)
      throw cause
    })

    expect(() => assembly.executor.layoutTransform(root, 'scale(.5)')).toThrow(cause)
    assembly.executor.layoutCleanup()

    expect(root.style.transform).toBe('rotate(20deg)')
    expect(root.getAnimations()).toEqual([])
    fail.mockRestore()
  })

  it('suppresses automatic output on every physical alias when another alias owns explicit none', () => {
    const source: PropertyIRDefinition = {
      ...layoutDefinition(),
      layers: [
        layoutDefinition().layers[0],
        {
          name: 'explicit',
          when: { kind: 'reference', path: ['active'] },
          targets: [
            {
              name: 'alias',
              properties: [{ name: 'transform', value: { kind: 'literal', value: 'none' } }],
            },
          ],
        },
      ],
    }
    const { assembly, targets, errors } = setup(source, { active: false })
    const root = targets.get('self')!
    assembly.executor.bind([
      ['self', root],
      ['alias', root],
    ])
    const before = assembly.executor.layoutCandidates()
    expect(before).toHaveLength(1)
    expect(before[0].blocked).toBe(false)
    assembly.executor.layoutTransform(root, 'matrix(.5, 0, 0, .5, 0, 0)')

    assembly.runtime.updateParameters({ active: true })

    expect(assembly.executor.layoutCandidates()[0].blocked).toBe(true)
    expect(root.style.transform).toBe('none')
    expect(errors).toEqual([])
  })

  it('suspends temporary projection through preview and releases it on receiver replacement', () => {
    const { assembly, targets, errors } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    assembly.executor.layoutTransform(root, 'matrix(.5, 0, 0, .5, 0, 0)')

    assembly.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )
    expect(assembly.executor.layoutCandidates()[0].blocked).toBe(true)
    expect(root.style.transform).toBe('')
    assembly.executor.endCompositionPreview()
    assembly.executor.layoutTransform(root, 'matrix(.5, 0, 0, .5, 0, 0)')
    const replacement = document.createElement('div')
    harness.append(replacement)

    assembly.executor.bind([['self', replacement]])

    expect(root.style.transform).toBe('')
    expect(assembly.executor.layoutCandidates()[0].element).toBe(replacement)
    expect(errors).toEqual([])
  })
  it('cancels a partially prepared observation effect when native startup fails', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    const cause = new Error('Observation startup failed')
    const pause = vi.spyOn(Animation.prototype, 'pause').mockImplementationOnce(() => {
      throw cause
    })
    let caught: unknown

    try {
      assembly.executor.layoutMeasure(root, new Map([['transform', 'none']]))
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(cause)
    expect(root.getAnimations()).toEqual([])
    pause.mockRestore()
  })

  it.each(['transform', 'opacity', 'other'] as const)(
    'derives physical transform ownership from active native %s tracks',
    (property) => {
      const source: PropertyIRDefinition = {
        ...layoutDefinition(),
        layers: [
          layoutDefinition().layers[0],
          {
            name: 'active',
            when: { kind: 'reference', path: ['active'] },
            timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
            targets: [
              {
                name: property === 'other' ? 'other' : 'self',
                properties: [
                  {
                    name: property === 'transform' ? 'transform' : 'opacity',
                    value: { kind: 'literal', value: property === 'transform' ? 'none' : '.5' },
                  },
                ],
              },
            ],
          },
        ],
      }
      const { assembly, targets, errors } = setup(source, { active: false })
      const root = targets.get('self')!
      assembly.executor.layoutTransform(root, 'matrix(.5,0,0,.5,0,0)')
      assembly.runtime.updateParameters({ active: true })
      for (const animation of nativeEffects(assembly.executor)) animation.pause()

      expect(nativeEffects(assembly.executor)).toHaveLength(1)
      expect(assembly.executor.layoutCandidates()[0].blocked).toBe(property === 'transform')
      expect(root.style.transform.startsWith('matrix(')).toBe(property !== 'transform')
      expect(errors).toEqual([])
    },
  )

  it('does not retain stale layout configuration when an accepted resolution omits layout output', () => {
    const { assembly } = setup(layoutDefinition(), { active: false })
    expect(assembly.executor.layoutCandidates()[0].configuration).toBeDefined()

    assembly.executor.initialize({
      composition: { layers: {}, states: {} },
      states: new Map(),
      transitions: new Map(),
      presentation: { name: '@layers', targets: [] },
    })

    expect(assembly.executor.layoutCandidates()[0].configuration).toBeUndefined()
  })

  it('keeps another receiver projection while captured Presence restores only its own receiver', () => {
    const source: PropertyIRDefinition = {
      ...layoutDefinition(),
      layers: [
        layoutDefinition().layers[0],
        {
          name: 'ordinary',
          targets: [
            {
              name: 'other',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
          ],
        },
      ],
      leave: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'other',
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
    const { assembly, targets, errors } = setup(source, { active: false })
    const root = targets.get('self')!
    assembly.executor.layoutTransform(root, 'matrix(.5,0,0,.5,0,0)')
    const operation = new PresenceOperation(capturePresence(assembly, 'leave', ['other']), 'leave')

    try {
      operation.play()
      expect(assembly.executor.layoutCandidates()[0].blocked).toBe(false)
      expect(root.style.transform.startsWith('matrix(')).toBe(true)
      expect(errors).toEqual([])
    } finally {
      operation.cancel('owner-teardown')
    }
  })
  it.each(['cleanup', 'next-read', 'dispose'] as const)(
    'retains a failed observation cancellation for %s retry without cancelling newer effects',
    (retry) => {
      const { assembly, targets } = setup(layoutDefinition(), { active: false })
      const root = targets.get('self')!
      assembly.executor.layoutTransform(root, 'matrix(.5,0,0,.5,0,0)')
      const before = new Set(root.getAnimations())
      const restore = assembly.executor.layoutMeasure(
        root,
        new Map([['transform', 'matrix(1,0,0,1,0,0)']]),
      )
      const held = root.getAnimations().find((animation) => !before.has(animation))
      if (!held) throw new Error('Expected live native observation')
      const cause = new Error('Native cancellation failed once')
      const cancel = vi.spyOn(held, 'cancel').mockImplementationOnce(() => {
        throw cause
      })
      let caught: unknown
      try {
        restore()
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(cause)
      expect(held.playState).toBe('paused')
      let next: (() => void) | undefined

      if (retry === 'cleanup') assembly.executor.layoutCleanup()
      else if (retry === 'next-read')
        next = assembly.executor.layoutMeasure(
          root,
          new Map([['transform', 'matrix(1,0,0,1,0,0)']]),
        )
      else assembly.runtime.dispose()

      expect(held.playState).toBe('idle')
      expect(cancel).toHaveBeenCalledTimes(2)
      const current = root.getAnimations()
      restore()
      expect(root.getAnimations()).toEqual(current)
      expect(current).toHaveLength(retry === 'next-read' ? 2 : 0)
      expect(cancel).toHaveBeenCalledTimes(2)
      expect(getComputedStyle(root).transform).toBe(
        retry === 'next-read' ? 'matrix(1, 0, 0, 1, 0, 0)' : 'none',
      )
      next?.()
      assembly.executor.layoutCleanup()
      expect(root.getAnimations()).toEqual([])
      cancel.mockRestore()
    },
  )

  it.each([
    'layout cancel',
    'inline restore',
    'ordinary restore',
    'notification',
    'combined',
  ] as const)('finishes independent final Runtime cleanup after a %s failure', (failure) => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const removed = vi.spyOn(media, 'removeEventListener')
    const cancelledFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const definition = layoutDefinition()
    const source: PropertyIRDefinition = {
      ...definition,
      layers: definition.layers.map((layer) => ({
        ...layer,
        targets: layer.targets.map((target) => ({
          ...target,
          properties: [
            ...target.properties,
            {
              name: 'left',
              value: { kind: 'literal', value: layer.name === 'base' ? '0%' : '50%' },
              timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
            },
          ],
        })),
      })),
    }
    const { assembly, targets } = setup(source, { active: false })
    const root = targets.get('self')!
    root.style.cssText += 'inline-size:100px;block-size:80px;position:relative;'
    const independent = new Animation(
      new KeyframeEffect(root, [{ color: 'red' }, { color: 'blue' }], 1000),
      document.timeline,
    )
    independent.pause()
    independent.currentTime = 333
    assembly.runtime.updateParameters({ active: true })
    const ordinary = [...nativeEffects(assembly.executor)]
    const frame: unknown = Reflect.get(assembly.executor, 'referenceFrame')
    assembly.executor.layoutTransform(root, 'scale(.5)')
    const output = root
      .getAnimations()
      .find(
        (animation) =>
          animation.effect instanceof KeyframeEffect &&
          animation.effect.getKeyframes().some((keyframe) => 'transform' in keyframe),
      )
    if (!output) throw new Error('Expected native layout output')
    const cause = new Error('Final layout cleanup failed')
    const notificationCause = new Error('Final ownership notification failed')
    const cancel = vi.spyOn(output, 'cancel')
    const restore = vi.spyOn(root.style, 'cssText', 'set')
    const notification = vi.fn<() => void>(() => {
      expect(assembly.executor.layoutCandidates()).toEqual([])
      if (failure === 'notification' || failure === 'combined') throw notificationCause
    })
    assembly.executor.onLayoutChange = notification

    if (failure === 'layout cancel' || failure === 'combined')
      cancel.mockImplementationOnce(() => {
        throw cause
      })
    if (failure === 'inline restore')
      restore.mockImplementationOnce(() => {
        throw cause
      })
    if (failure === 'ordinary restore') {
      const set = Object.getOwnPropertyDescriptor(
        CSSStyleDeclaration.prototype,
        'cssText',
      )?.set?.bind(root.style)
      if (!set) throw new Error('Expected native CSSOM setter')
      restore
        .mockImplementationOnce((value: string) => {
          set(value)
        })
        .mockImplementationOnce(() => {
          throw cause
        })
    }

    try {
      expect(ordinary.length).toBeGreaterThan(0)
      expect(root.getBoundingClientRect().width).toBeCloseTo(50, 4)
      expect(typeof frame).toBe('number')

      let caught: unknown
      try {
        assembly.runtime.dispose()
      } catch (error) {
        caught = error
      }

      const primary = failure === 'notification' ? notificationCause : cause
      const failures: unknown[] = caught instanceof AggregateError ? caught.errors : [caught]
      expect(failures).toHaveLength(failure === 'combined' ? 2 : 1)
      expect(failures[0]).toBe(primary)
      expect(failures.at(-1)).toBe(failure === 'combined' ? notificationCause : primary)
      expect(caught instanceof AggregateError ? caught.cause : caught).toBe(primary)
      expect(assembly.runtime.isDisposed).toBe(true)
      expect(notification).toHaveBeenCalledOnce()
      expect(ordinary.every((animation) => animation.playState === 'idle')).toBe(true)
      expect(assembly.executor.presentationFacts().receivers).toEqual([])
      expect(Reflect.get(assembly.executor, 'environment')).toBeUndefined()
      expect(cancelledFrame).toHaveBeenCalledWith(frame)
      expect(removed).toHaveBeenCalledWith('change', expect.any(Function))
      expect(independent.playState).toBe('paused')
      expect(independent.currentTime).toBe(333)

      assembly.executor.bind([...targets])
      expect(assembly.executor.presentationFacts().receivers).toEqual([])
      assembly.executor.layoutCleanup()
      assembly.executor.onLayoutChange = undefined
      assembly.executor.dispose()
      expect(output.playState).toBe('idle')
      expect(root.style.transform).toBe('')
      expect(root.getAnimations()).toEqual([independent])
    } finally {
      assembly.executor.onLayoutChange = undefined
      cancel.mockRestore()
      restore.mockRestore()
      assembly.executor.layoutCleanup()
      independent.cancel()
      removed.mockRestore()
      cancelledFrame.mockRestore()
      factory.mockRestore()
    }
  })

  it('retains a failed ordinary final cancellation without leaving live execution callbacks', () => {
    const source = layoutDefinition()
    const timed: PropertyIRDefinition = {
      ...source,
      layers: source.layers.map((layer) => ({
        ...layer,
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
      })),
    }
    const { assembly } = setup(timed, { active: false })
    assembly.runtime.updateParameters({ active: true })
    const effect = nativeEffects(assembly.executor)[0]
    if (!effect) throw new Error('Expected ordinary animated ownership')
    const cause = new Error('Ordinary native cancel failed once')
    const cancel = vi.spyOn(effect, 'cancel').mockImplementationOnce(() => {
      throw cause
    })

    try {
      expect(() => assembly.runtime.dispose()).toThrow(cause)
      expect(nativeEffects(assembly.executor)).toEqual([])
      expect(assembly.executor.presentationFacts().receivers).toEqual([])
      expect(Reflect.get(assembly.executor, 'environment')).toBeUndefined()

      assembly.executor.dispose()

      expect(effect.playState).toBe('idle')
      expect(cancel).toHaveBeenCalledTimes(2)
    } finally {
      cancel.mockRestore()
      assembly.executor.dispose()
    }
  })

  it('preserves startup and cancellation causes while retaining failed native cleanup', () => {
    const { assembly, targets } = setup(layoutDefinition(), { active: false })
    const root = targets.get('self')!
    const cause = new Error('Native startup failed')
    const cleanupCause = new Error('Native cleanup failed')
    const pause = vi.spyOn(Animation.prototype, 'pause').mockImplementationOnce(() => {
      throw cause
    })
    const cancel = vi.spyOn(Animation.prototype, 'cancel').mockImplementationOnce(() => {
      throw cleanupCause
    })
    let caught: unknown

    try {
      assembly.executor.layoutMeasure(root, new Map([['transform', 'none']]))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({ cause, errors: [cause, cleanupCause] })
    assembly.executor.layoutCleanup()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(root.getAnimations()).toEqual([])
    pause.mockRestore()
    cancel.mockRestore()
  })
})
