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
