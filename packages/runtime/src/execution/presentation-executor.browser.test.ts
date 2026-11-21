import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import { PresenceOperation } from './presence-operation.ts'
import { decodeBundle, type Definition as PropertyIRDefinition } from '../model/definition.ts'
import fixture from '../../../../fixtures/toggle.json'
import selfFixture from '../../../../fixtures/self-target.json'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const harness = createBrowserRuntimeHarness()

function setup(
  def = definition,
  inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
    ? { mode: 'off' }
    : {},
) {
  return harness.setup(def, inputs)
}

function updateMode(assembly: RuntimeAssembly, mode: string, options: { paused?: boolean } = {}) {
  assembly.runtime.updateParameters({ mode })

  if (options.paused) {
    for (const animation of nativeEffects(assembly.executor)) animation.pause()
  }
}

afterEach(() => harness.dispose())

function capturedLeaveEffect(assembly: RuntimeAssembly) {
  const previous = new Set(nativeEffects(assembly.executor))
  const operation = new PresenceOperation(capturePresence(assembly, 'leave', ['thumb']), 'leave')

  try {
    operation.play()

    const effect = nativeEffects(assembly.executor).find(
      (animation) => !previous.has(animation),
    )?.effect

    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected captured native effect')

    return effect
  } finally {
    operation.cancel('owner-teardown')
  }
}

function setupRepeatedThumb() {
  const source: PropertyIRDefinition = {
    ...definition,
    enter: { targets: [] },
    leave: {
      timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
      targets: [
        {
          name: 'thumb',
          properties: [
            {
              name: 'opacity',
              keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
            },
          ],
        },
      ],
    },
    letBindings: [
      {
        name: 'receiver',
        initializer: {
          kind: 'call',
          function: 'interaction',
          arguments: [{ name: 'target', value: { kind: 'reference', path: ['thumb'] } }],
        },
      },
    ],
    events: [{ name: 'focus', when: { kind: 'reference', path: ['receiver', 'focus'] } }],
  }

  const { assembly, targets, errors } = setup(source)
  // The toggle fixture declares thumb, and setup binds every declared target.
  const first = targets.get('thumb')!
  const second = document.createElement('div')
  first.tabIndex = 0
  first.style.opacity = '0.2'
  second.tabIndex = 0
  second.style.opacity = '0.8'

  harness.append(second)
  assembly.executor.bind([...targets, ['thumb', second]])

  return { assembly, targets, first, second, errors }
}

describe('PresentationExecutor browser execution', () => {
  it('captures a repeated target from its last accepted receiver', () => {
    const { assembly, second, errors } = setupRepeatedThumb()

    const effect = capturedLeaveEffect(assembly)

    expect(effect.target).toBe(second)
    expect(effect.getKeyframes()[0].opacity).toBe('0.8')
    expect(errors).toEqual([])
  })

  it.each(['reordered', 'repeated'] as const)(
    'preserves accepted receivers and effects for %s entries matching the unchanged check',
    (order) => {
      const { assembly, targets, first, second, errors } = setupRepeatedThumb()

      updateMode(assembly, 'on', { paused: true })
      const animations = nativeEffects(assembly.executor)

      expect(animations.length).toBeGreaterThan(0)

      const entries: (readonly [string, HTMLElement])[] =
        order === 'reordered' ? [['thumb', second], ...targets] : [...targets, ['thumb', first]]

      assembly.executor.bind(entries)

      expect(nativeEffects(assembly.executor)).toEqual(animations)
      expect(capturedLeaveEffect(assembly).target).toBe(second)
      expect(first.style.translate).toBe('24px')
      expect(second.style.translate).toBe('24px')
      expect(errors).toEqual([])
    },
  )

  it('rebuilds unbound receivers and completes new effects through aliases of the same element', async () => {
    const { assembly, second, errors } = setupRepeatedThumb()

    updateMode(assembly, 'on', { paused: true })
    const previous = [...nativeEffects(assembly.executor)]

    expect(previous.length).toBeGreaterThan(0)

    assembly.executor.bind([])

    expect(nativeEffects(assembly.executor)).toEqual([])
    expect(previous.every((animation) => animation.playState === 'idle')).toBe(true)

    assembly.executor.bind([
      ['thumb', second],
      ['track', second],
    ])
    updateMode(assembly, 'off', { paused: true })
    const replacements = [...nativeEffects(assembly.executor)]
    const finished = replacements.map((animation) => animation.finished)

    expect(replacements.length).toBeGreaterThan(0)
    expect(
      replacements.every(
        (animation) =>
          animation.effect instanceof KeyframeEffect && animation.effect.target === second,
      ),
    ).toBe(true)

    for (const animation of replacements) animation.finish()

    await Promise.all(finished)

    expect(nativeEffects(assembly.executor)).toEqual([])
    expect(Number.parseFloat(getComputedStyle(second).translate)).toBe(0)
    expect(errors).toEqual([])
  })

  it('connects reactive calls to the last receiver and reconnects when that receiver is removed', async () => {
    const { assembly, targets, first, second, errors } = setupRepeatedThumb()
    const focused = vi.fn<(name: string) => void>()
    assembly.runtime.onEvent = focused

    first.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).not.toHaveBeenCalled()

    second.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).toHaveBeenCalledExactlyOnceWith('focus')

    assembly.executor.bind([...targets])
    focused.mockClear()
    first.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).toHaveBeenCalledExactlyOnceWith('focus')
    expect(second.style.translate).toBe('')
    expect(errors).toEqual([])
  })

  it('does not observe styles for unchanged untimed presentations', () => {
    const source: PropertyIRDefinition = {
      name: 'untimed',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'opacity', value: { kind: 'literal', value: '1' } },
                { name: 'width', value: { kind: 'literal', value: '10px' } },
                { name: 'height', value: { kind: 'literal', value: '20px' } },
              ],
            },
          ],
        },
      ],
    }
    const { assembly } = setup(source)
    const observe = vi.spyOn(window, 'getComputedStyle')

    try {
      for (let update = 0; update < 10; update++) assembly.runtime.updateParameters({})

      expect(observe).not.toHaveBeenCalled()
      expect(nativeEffects(assembly.executor)).toEqual([])
    } finally {
      observe.mockRestore()
    }
  })

  it('plays compiled explicit self properties on the root with their shared timing', async () => {
    const source = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { assembly, targets, errors } = setup(source, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    assembly.runtime.updateParameters({ active: true })
    const animation = nativeEffects(assembly.executor)[0]

    expect(nativeEffects(assembly.executor)).toHaveLength(1)
    expect(animation.effect?.getTiming().duration).toBe(150)

    animation.pause()
    animation.currentTime = 75

    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(1)
    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('keeps missing bindings suspended across definition replacement and empty input updates', () => {
    const source = {
      name: 'static',
      layers: [
        {
          name: 'base',
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
    } satisfies PropertyIRDefinition
    const { assembly, targets } = setup(source)

    assembly.executor.bind([])
    assembly.runtime.replaceDefinition(source)
    assembly.runtime.updateParameters({})

    expect(nativeEffects(assembly.executor)).toHaveLength(0)
    expect(targets.get('body')!.style.opacity).toBe('')

    assembly.executor.bind([...targets])

    expect(targets.get('body')!.style.opacity).toBe('1')
  })

  it('keeps rejected duplicates suspended when replacement adds lifecycle support until rebinding', () => {
    const { assembly, targets, errors } = setup()
    // setup binds every target declared by the toggle fixture, including thumb.
    const thumb = targets.get('thumb')!
    const duplicate = [...targets, ['thumb', thumb] as const]

    assembly.executor.bind(duplicate)
    assembly.runtime.replaceDefinition({ ...definition, enter: { targets: [] } })
    updateMode(assembly, 'on')

    expect(thumb.style.translate).toBe('')
    expect(nativeEffects(assembly.executor)).toHaveLength(0)
    expect(errors).toEqual([
      expect.objectContaining({ code: 'runtime.targets', message: 'Duplicate target binding' }),
    ])

    assembly.executor.bind(duplicate)

    expect(thumb.style.translate).toBe('24px')
  })

  it('restores variable shorthands and preserves external priority changes', () => {
    const def = {
      name: 'spacing',
      layers: [
        {
          name: 'on',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'margin',
                  value: {
                    kind: 'literal',
                    value: 'var(--b)',
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies PropertyIRDefinition
    const element = document.createElement('div')

    element.style.cssText = 'margin: var(--a); width: 12px !important; color: red'
    harness.append(element)

    const assembly = assembleRuntime(def)

    harness.trackAssembly(assembly)
    assembly.executor.bind([['box', element]])
    element.style.width = '20px'
    element.style.removeProperty('color')
    assembly.runtime.dispose()

    expect(element.style.margin).toBe('var(--a)')
    expect(element.style.width).toBe('20px')
    expect(element.style.getPropertyPriority('width')).toBe('')
    expect(element.style.color).toBe('')

    const second = assembleRuntime(def)

    harness.trackAssembly(second)
    second.executor.bind([['box', element]])
    element.style.setProperty('margin', 'var(--external)', 'important')
    second.runtime.dispose()

    expect(element.style.margin).toBe('var(--external)')
    expect(element.style.getPropertyPriority('margin')).toBe('important')
  })

  it.each(['dispose', 'replace', 'presence'] as const)(
    'ignores a queued animation completion after %s',
    async (operation) => {
      const { assembly, targets } = setup({
        ...definition,
        leave: {
          timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
          targets: [
            {
              name: 'track',
              properties: [
                {
                  name: 'background-color',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: 'blue' } }],
                },
              ],
            },
          ],
        },
      })
      let presence: PresenceOperation | undefined

      updateMode(assembly, 'on')

      const animation = nativeEffects(assembly.executor)[0]

      await animation.ready
      animation.finish()

      const finished = animation.finished

      if (operation === 'dispose') assembly.runtime.dispose()
      else if (operation === 'replace') assembly.runtime.replaceDefinition(definition)
      else {
        presence = new PresenceOperation(capturePresence(assembly, 'leave', ['track']), 'leave')
        presence.initialize()
      }

      targets.get('track')!.style.backgroundColor = 'blue'

      await finished

      await Promise.resolve()

      expect(nativeEffects(assembly.executor)).not.toContain(animation)
      expect(targets.get('track')!.style.backgroundColor).toBe('blue')

      presence?.cancel('owner-teardown')
    },
  )

  it('replaces only an animated template property when its value changes within a state', () => {
    const def = {
      name: 'dynamic',
      parameters: [
        { name: 'checked', type: 'boolean' },
        { name: 'x', type: 'number' },
      ] as const,
      layers: [
        {
          name: 'off',
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'width',
                  value: {
                    kind: 'literal',
                    value: '0px',
                  },
                },
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
            {
              name: 'badge',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'on',
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } as const,
          when: { kind: 'reference', path: ['checked'] } as const,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'width',
                  value: {
                    kind: 'template',
                    parts: [{ kind: 'reference', path: ['x'] } as const, 'px'],
                  },
                },
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
            {
              name: 'badge',
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
    } satisfies PropertyIRDefinition
    const { assembly, targets } = setup(def, { checked: false, x: 10 })

    const empty = new PresenceOperation(capturePresence(assembly, 'enter', ['box']), 'enter')

    empty.play()

    expect(nativeEffects(assembly.executor)).toEqual([])

    assembly.runtime.updateParameters({ checked: true, x: 10 })

    expect(nativeEffects(assembly.executor)).toHaveLength(3)

    const previous = [...nativeEffects(assembly.executor)]

    assembly.runtime.updateParameters({ checked: true, x: 20 })

    expect(nativeEffects(assembly.executor)).toHaveLength(3)
    expect(
      previous.filter((animation) => nativeEffects(assembly.executor).includes(animation)),
    ).toHaveLength(2)
    expect(targets.get('box')!.style.width).toBe('20px')
  })

  it('restores removed owned declarations but preserves external removals', () => {
    const element = document.createElement('div')

    element.style.cssText = 'width: 10px; height: 10px'
    harness.append(element)

    const def = {
      name: 'remove',
      layers: [
        {
          name: 'off',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'width',
                  value: {
                    kind: 'literal',
                    value: '',
                  },
                },
                {
                  name: 'height',
                  value: {
                    kind: 'literal',
                    value: '20px',
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies PropertyIRDefinition
    const assembly = assembleRuntime(def)

    harness.trackAssembly(assembly)
    assembly.executor.bind([['box', element]])

    expect(element.style.width).toBe('')

    element.style.removeProperty('height')
    assembly.runtime.dispose()

    expect(element.style.width).toBe('10px')
    expect(element.style.height).toBe('')
  })
})

describe('feature-scoped browser execution', () => {
  it('renders and restores a tween Motion with only its pure implementations', async () => {
    const { MotionRuntime, BrowserExecutor } = await import('../core.ts')
    const { tween } = await import('../evaluation/timing-builtins.ts')
    const { linear } = await import('../evaluation/constants.ts')
    const source: PropertyIRDefinition = {
      name: 'opacity',
      parameters: [{ name: 'active', type: 'boolean' }],
      letBindings: [
        {
          name: 'timing',
          initializer: {
            kind: 'call',
            function: 'tween',
            arguments: [
              { name: 'duration', value: { kind: 'number', value: 300 } },
              { name: 'easing', value: { kind: 'reference', path: ['linear'] } },
            ],
          },
        },
      ],
      layers: [
        {
          name: 'base',
          timingExpression: { kind: 'reference', path: ['timing'] },
          targets: [
            {
              name: 'self',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.4' } }],
            },
          ],
        },
        {
          name: 'active',
          when: { kind: 'reference', path: ['active'] },
          targets: [
            {
              name: 'self',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
          ],
        },
      ],
    }
    const errors: unknown[] = []
    const report = (error: unknown) => errors.push(error)
    const executor = new BrowserExecutor(report)
    const runtime = new MotionRuntime(executor, source, { active: false }, report, {
      pure: { constants: { linear }, functions: { tween } },
    })
    const element = document.createElement('div')
    element.style.opacity = '0.2'
    harness.append(element)
    executor.attach(runtime.environment)

    try {
      executor.bind([['self', element]])
      expect(element.style.opacity).toBe('0.4')
      expect(runtime.layout).toEqual([])

      runtime.updateParameters({ active: true })

      const [animation] = element.getAnimations()
      expect(animation.effect?.getComputedTiming().duration).toBe(300)

      animation.finish()
      await animation.finished
      expect(element.style.opacity).toBe('1')

      runtime.replaceDefinition({ ...source, layers: source.layers.slice(0, 1) })

      expect(element.style.opacity).toBe('0.4')
      expect(runtime.evaluateCandidate(source, (values) => values.timing)).toEqual({
        kind: 'tween',
        durationMs: 300,
        easing: 'linear',
      })

      expect(errors).toEqual([])
    } finally {
      runtime.dispose()
    }

    expect(element.style.opacity).toBe('0.2')
    expect(element.getAnimations()).toEqual([])
  })
})

describe('feature boundaries', () => {
  it('leaves ordinary playback and styles intact when layout is absent', async () => {
    const { BrowserExecutor, MotionRuntime } = await import('../core.ts')
    const executor = new BrowserExecutor(console.warn)
    const runtime = new MotionRuntime(executor, { name: 'plain', layers: [] }, {}, console.warn)
    const target = document.createElement('div')
    target.style.transform = 'translateX(5px)'
    harness.append(target)
    executor.attach(runtime.environment)

    try {
      executor.bind([['self', target]])

      const revision = executor.layoutRevision
      const restore = executor.layoutMeasure(target, new Map([['transform', 'none']]))

      expect(executor.layoutCandidates(revision)).toEqual([])
      expect(executor.lifecycleOwns(target, 'transform')).toBe(false)
      expect(target.style.transform).toBe('translateX(5px)')

      restore()
      expect(target.getAnimations()).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('reports unavailable optional operations before creating browser work', async () => {
    const { BrowserExecutor } = await import('../core.ts')
    const executor = new BrowserExecutor(console.warn)
    const values = {}
    const resolution = {
      composition: { layers: {}, states: {} },
      states: new Map(),
      transitions: new Map(),
      presentation: { name: '@layers', targets: [] },
    }
    const source = {
      value: true,
      bind() {
        throw new Error('Unexpected browser connection')
      },
    }

    expect(() => executor.capturePresence('leave', ['self'])).toThrow('Missing Presence capability')
    expect(() => executor.connectSource(source, () => {})).toThrow(
      'Missing reactive source capability',
    )
    expect(() => executor.beginPreview([])).toThrow('Missing preview capability')
    expect(() => executor.completePreview()).toThrow('Missing preview capability')
    expect(executor.observeReceivers(resolution, new Set(['self']), true)).toEqual([])
    expect(executor.applyControllers([], values, performance.now(), true).size).toBe(0)
  })
})
