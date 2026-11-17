import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { cdp } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import selfFixture from '../../../../fixtures/self-target.json'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle, type Definition as PropertyIRDefinition } from '../model/definition.ts'
import type { RuntimeDiagnostic } from './execution-contracts.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import type { Definition } from '../model/definition.ts'
import { PresenceOperation } from './presence-operation.ts'

const timing = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
const source: Definition = {
  name: 'scoped-preview',
  layers: [
    {
      name: 'base',
      timing,
      targets: [
        {
          name: 'body',
          properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
        },
      ],
    },
    {
      name: 'active',
      when: { kind: 'boolean', value: false },
      timing,
      targets: [
        { name: 'body', properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }] },
      ],
    },
  ],
  leave: {
    timing,
    targets: [
      {
        name: 'body',
        properties: [
          {
            name: 'opacity',
            keyframes: [
              { offset: 0, value: { kind: 'literal', value: '0.2' } },
              { offset: 1, value: { kind: 'literal', value: '0' } },
            ],
          },
        ],
      },
    ],
  },
}
const from = { layers: { base: true, active: false }, states: {} }
const to = { layers: { base: true, active: true }, states: {} }
const registrations: { assembly: RuntimeAssembly; element: HTMLElement }[] = []

function setup(definition = source) {
  const element = document.createElement('div')
  const errors: RuntimeDiagnostic[] = []
  const assembly = assembleRuntime(definition, {}, (diagnostic) => errors.push(diagnostic))

  document.body.append(element)
  assembly.executor.bind([['body', element]])
  registrations.push({ assembly, element })

  return { ...assembly, element, errors }
}

afterEach(() => {
  for (const { assembly, element } of registrations.splice(0)) {
    assembly.runtime.dispose()
    element.remove()
  }
})

describe('scoped preview operations', () => {
  it('starts paused at zero, seeks both ways and ignores non-finite positions', async () => {
    const { inspection, executor, element } = setup()
    const preview = inspection.previewComposition(from, to)

    await Promise.all(nativeEffects(executor).map((effect) => effect.ready))

    expect(
      nativeEffects(executor).every(
        (effect) => effect.playState === 'paused' && effect.currentTime === 0,
      ),
    ).toBe(true)

    preview.seek(750)
    expect(getComputedStyle(element).opacity).toBe('0.8')

    preview.seek(250)
    expect(getComputedStyle(element).opacity).toBe('0.4')

    preview.seek(NaN)
    preview.seek(Infinity)
    expect(getComputedStyle(element).opacity).toBe('0.4')

    preview.seek(-100)
    expect(getComputedStyle(element).opacity).toBe('0.2')

    preview.end()
    preview.seek(800)
    preview.end()

    expect(nativeEffects(executor)).toEqual([])
    expect(element.style.opacity).toBe('0.2')
  })

  it('prevents a stale handle from seeking or restoring a replacement preview', () => {
    const { inspection, executor, element } = setup()
    const previous = inspection.previewComposition(from, to)
    const current = inspection.previewComposition(to, from)

    current.seek(250)
    previous.seek(900)
    previous.end()

    expect(getComputedStyle(element).opacity).toBe('0.8')
    expect(nativeEffects(executor)).toHaveLength(1)

    current.end()

    expect(element.style.opacity).toBe('0.2')
    expect(nativeEffects(executor)).toEqual([])
  })

  it('does not scrub retained live leave and expires its handle on disposal', async () => {
    const { runtime, inspection, executor, element } = setup()
    const leave = new PresenceOperation([executor.capturePresence('leave', ['body'])], 'leave')
    leave.play()
    const effect = nativeEffects(executor)[0]
    effect.pause()
    effect.currentTime = 100

    const preview = inspection.previewComposition(from, to)
    preview.seek(750)

    expect(effect.currentTime).toBe(100)
    // The paused leave supplies 0.18 as the displayed start: 0.18 + (1 - 0.18) * 0.75.
    expect(getComputedStyle(element).opacity).toBe('0.795')

    runtime.dispose()
    preview.seek(200)
    preview.end()

    expect(effect.currentTime).toBe(100)
    expect(leave.isFinished).toBe(false)

    leave.cancel('owner-teardown')

    await expect(leave.finished).resolves.toBe('owner-teardown')
  })

  it('preserves native preparation failure and reports a separate restoration failure', () => {
    const { inspection, executor, element, errors } = setup()
    const failure = new Error('Native preparation failed')
    const cleanup = new Error('Restoration failed')
    const prepare = vi.spyOn(window, 'KeyframeEffect').mockImplementationOnce(function () {
      throw failure
    })
    const restore = vi.spyOn(executor, 'abortPreview').mockImplementationOnce(() => {
      throw cleanup
    })
    let caught: unknown

    try {
      inspection.previewComposition(from, to)
    } catch (error) {
      caught = error
    }

    expect(caught).toEqual(new Error('Could not prepare composition preview', { cause: failure }))
    expect(errors.map(({ code, error }) => ({ code, error }))).toEqual([
      { code: 'runtime.preview-cleanup', error: cleanup },
      { code: 'runtime.preview', error: caught },
    ])
    prepare.mockRestore()
    restore.mockRestore()

    executor.endCompositionPreview()

    expect(element.style.opacity).toBe('0.2')
    expect(nativeEffects(executor)).toEqual([])
  })

  it('issues an empty preview handle with the same termination contract', () => {
    const { inspection, executor, element } = setup({ name: 'empty', layers: [] })
    const preview = inspection.previewComposition(
      { layers: {}, states: {} },
      { layers: {}, states: {} },
    )

    preview.seek(100)

    expect(nativeEffects(executor)).toEqual([])
    expect(element.style.opacity).toBe('')

    preview.end()
    expect(element.style.opacity).toBe('')
  })
})

function updateMode(assembly: RuntimeAssembly, mode: string, options: { paused?: boolean } = {}) {
  assembly.runtime.updateParameters({ mode })

  if (options.paused) {
    for (const animation of nativeEffects(assembly.executor)) animation.pause()
  }
}

describe('composition and lifecycle previews', () => {
  const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
  const harness = createBrowserRuntimeHarness()

  function setupBrowserRuntime(
    def = definition,
    inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
      ? { mode: 'off' }
      : {},
  ) {
    return harness.setup(def, inputs)
  }

  afterEach(() => harness.dispose())

  it('previews distinct properties through self and an alias of the same element', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const previewDefinition: PropertyIRDefinition = {
      name: 'alias-preview',
      layers: [
        {
          name: 'base',
          timing: tween,
          targets: [
            {
              name: 'self',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0' } }],
            },
            {
              name: 'alias',
              properties: [{ name: 'width', value: { kind: 'literal', value: '10px' } }],
            },
          ],
        },
        {
          name: 'active',
          when: { kind: 'boolean', value: false },
          timing: tween,
          targets: [
            {
              name: 'self',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
            {
              name: 'alias',
              properties: [{ name: 'width', value: { kind: 'literal', value: '30px' } }],
            },
          ],
        },
      ],
    }
    const { assembly, targets, errors } = setupBrowserRuntime(previewDefinition)
    const root = targets.get('self')!
    assembly.executor.bind([
      ['self', root],
      ['alias', root],
    ])

    assembly.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )

    await Promise.all(nativeEffects(assembly.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 500

    expect(nativeEffects(assembly.executor)).toHaveLength(2)
    expect(getComputedStyle(root).opacity).toBe('0.5')
    expect(getComputedStyle(root).width).toBe('20px')
    expect(errors).toEqual([])

    assembly.executor.endCompositionPreview()

    expect(root.style.opacity).toBe('0')
    expect(root.style.width).toBe('10px')
  })

  it('uses each alias target cascade when expanding overlapping preview properties', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const previewDefinition: PropertyIRDefinition = {
      name: 'alias-ownership',
      layers: [
        {
          name: 'base',
          timing: tween,
          targets: [
            {
              name: 'self',
              properties: [
                { name: 'inset', value: { kind: 'literal', value: '0px' } },
                { name: 'left', value: { kind: 'literal', value: '20px' } },
              ],
            },
            {
              name: 'alias',
              properties: [{ name: 'inset', value: { kind: 'literal', value: '0px' } }],
            },
          ],
        },
        {
          name: 'active',
          when: { kind: 'boolean', value: false },
          timing: tween,
          targets: [
            {
              name: 'alias',
              properties: [{ name: 'inset', value: { kind: 'literal', value: '10px' } }],
            },
          ],
        },
      ],
    }
    const { assembly, targets, errors } = setupBrowserRuntime(previewDefinition)
    const root = targets.get('self')!
    root.style.position = 'relative'
    assembly.executor.bind([
      ['self', root],
      ['alias', root],
    ])

    assembly.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )

    await Promise.all(nativeEffects(assembly.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 500

    expect(nativeEffects(assembly.executor)).toHaveLength(8)
    expect(getComputedStyle(root).left).toBe('5px')
    expect(errors).toEqual([])

    assembly.executor.endCompositionPreview()
  })

  it.each(['enter', 'leave'] as const)(
    'does not observe unused ordinary addresses during %s previews',
    async (phase) => {
      const previewDefinition: PropertyIRDefinition = {
        name: 'lifecycle-observations',
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'width', value: { kind: 'literal', value: '10px' } },
                  { name: 'height', value: { kind: 'literal', value: '20px' } },
                  { name: 'opacity', value: { kind: 'literal', value: '1' } },
                ],
              },
              {
                name: 'unrelated',
                properties: [
                  { name: 'width', value: { kind: 'literal', value: '30px' } },
                  { name: 'height', value: { kind: 'literal', value: '40px' } },
                ],
              },
            ],
          },
        ],
        [phase]: {
          timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    { offset: phase === 'enter' ? 0 : 1, value: { kind: 'literal', value: '0' } },
                  ],
                },
              ],
            },
          ],
        },
      }
      const { assembly, targets, errors } = setupBrowserRuntime(previewDefinition)
      const element = targets.get('box')
      const unrelated = targets.get('unrelated')

      expect(element).toBeDefined()
      expect(unrelated).toBeDefined()

      const observe = vi.spyOn(window, 'getComputedStyle')
      let reads: number
      let unrelatedReads: number

      try {
        assembly.inspection.previewLifecycle(phase)
        reads = observe.mock.calls.length
        unrelatedReads = observe.mock.calls.filter(([receiver]) => receiver === unrelated).length
      } finally {
        observe.mockRestore()
      }

      await Promise.all(nativeEffects(assembly.executor).map((animation) => animation.ready))

      for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 100

      // Only the phase's opacity can need a displayed snapshot; ordinary lengths
      // and the target without phase tracks require no writing-context observation.
      expect(reads).toBeLessThanOrEqual(1)
      expect(unrelatedReads).toBe(0)
      expect(getComputedStyle(element!).opacity).toBe('0.5')
      expect(errors).toEqual([])

      assembly.executor.endCompositionPreview()
    },
  )

  it('scrubs canonical preview tracks with the same overlapping-property ownership as playback', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const previewDefinition: PropertyIRDefinition = {
      name: 'canonical-preview',
      layers: [
        {
          name: 'base',
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'inset', value: { kind: 'literal', value: '0px' } },
                { name: 'left', value: { kind: 'literal', value: '20px' } },
              ],
            },
          ],
        },
        {
          name: 'active',
          when: { kind: 'boolean', value: false },
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'inset', value: { kind: 'literal', value: '10px' } }],
            },
          ],
        },
      ],
    }
    const { assembly, targets, errors } = setupBrowserRuntime(previewDefinition)
    const element = targets.get('box')

    expect(element).toBeDefined()

    assembly.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )
    await Promise.all(nativeEffects(assembly.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 500

    expect(nativeEffects(assembly.executor)).toHaveLength(4)
    expect(getComputedStyle(element!).left).toBe('15px')
    expect(getComputedStyle(element!).right).toBe('5px')

    assembly.executor.endCompositionPreview()

    expect(element!.style.left).toBe('20px')
    expect(nativeEffects(assembly.executor)).toEqual([])
    expect(errors).toEqual([])
  })

  it('scrubs compiled self lifecycle timing without leaking to shorthand endpoints', () => {
    const previewDefinition = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { assembly, targets } = setupBrowserRuntime(previewDefinition, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    assembly.inspection.previewLifecycle('enter', {
      layers: { base: true, interaction: false },
      states: {},
    })

    for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 100

    // Default tween easing is ease, so use actual effect timings rather than assume linear interpolation.
    expect(
      nativeEffects(assembly.executor)
        .map((animation) => Number(animation.effect?.getTiming().duration))
        .toSorted((a, b) => a - b),
    ).toEqual([200, 400])
    expect(Number(getComputedStyle(root!).opacity)).toBeGreaterThan(0)
    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(0.8)

    assembly.executor.endCompositionPreview()

    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(getComputedStyle(root!).scale).toBe('1')
  })

  it('settles active effects when reduced motion is enabled but preserves manual previews', async () => {
    const { assembly, targets } = setupBrowserRuntime()

    updateMode(assembly, 'on')

    const session: CDPSession = cdp()

    try {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })

      await new Promise(requestAnimationFrame)

      await expect.poll(() => nativeEffects(assembly.executor).length).toBe(0)
      expect(targets.get('thumb')!.style.translate).toBe('24px')

      assembly.inspection.previewComposition(
        { layers: {}, states: { toggle: 'on' } },
        { layers: {}, states: { toggle: 'off' } },
        [{ layer: 'toggle', index: 1 }],
      )

      expect(nativeEffects(assembly.executor).length).toBeGreaterThan(0)

      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      })

      await new Promise(requestAnimationFrame)

      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })

      await new Promise(requestAnimationFrame)

      expect(nativeEffects(assembly.executor).length).toBeGreaterThan(0)
    } finally {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      })

      await new Promise(requestAnimationFrame)
    }
  })

  it.each(['enter', 'leave'] as const)(
    'scrubs %s templates on repeated targets and restores the application composition',
    (phase) => {
      const def = {
        name: 'panel',
        parameters: [{ name: 'opacity', type: 'number' as const }],
        layers: [
          {
            name: 'idle',
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'opacity',
                    value: {
                      kind: 'literal',
                      value: '1',
                    },
                  },
                ],
              },
            ],
          },
        ],
        [phase]: {
          timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    {
                      offset: phase === 'enter' ? 0 : 1,
                      value: {
                        kind: 'template' as const,
                        parts: [{ kind: 'reference' as const, path: ['opacity'] }],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      } satisfies PropertyIRDefinition
      const { assembly, targets, errors } = setupBrowserRuntime(def, { opacity: 0.2 })
      const second = document.createElement('div')
      harness.append(second)
      assembly.executor.bind([
        ['body', targets.get('body')!],
        ['body', second],
      ])

      assembly.inspection.previewLifecycle(phase)
      expect(nativeEffects(assembly.executor)).toHaveLength(2)

      for (const animation of nativeEffects(assembly.executor)) animation.currentTime = 100

      for (const element of [targets.get('body')!, second]) {
        expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(0.6)
        expect(element.isConnected).toBe(true)
      }

      assembly.runtime.replaceDefinition(def)

      expect(nativeEffects(assembly.executor)).toHaveLength(0)
      expect(getComputedStyle(second).opacity).toBe('1')
      expect(errors).toEqual([])

      assembly.runtime.dispose()
      expect(() => assembly.inspection.previewLifecycle(phase)).toThrow('mounted')
    },
  )
})
