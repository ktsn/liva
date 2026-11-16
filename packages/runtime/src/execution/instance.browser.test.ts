import * as functions from '../builtins/index.ts'
import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import type { Definition as PropertyIRDefinition } from '../model/definition.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import constrainedFixture from '../../../../fixtures/constrained.json'
import selfFixture from '../../../../fixtures/self-target.json'
import fixture from '../../../../fixtures/toggle.json'
import reactiveFixture from '../../../../fixtures/reactive-toggle.json'
import cardFixture from '../../../../fixtures/card.json'
import { layerTargets } from '../composition/layers.ts'
import { decodeBundle } from '../model/definition.ts'
import type { RuntimeDiagnostic } from './execution-contracts.ts'
import { PresenceOperation } from './presence-operation.ts'

vi.mock('../builtins/index.ts', { spy: true })

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const instances: RuntimeAssembly[] = []
const elements: HTMLElement[] = []

function setup(
  def = definition,
  inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
    ? { mode: 'off' }
    : {},
) {
  const errors: RuntimeDiagnostic[] = []
  const instance = assembleRuntime(def, inputs, (error) => errors.push(error))
  const targets = new Map(
    layerTargets(def).map(({ name }) => {
      const element = document.createElement('div')

      document.body.append(element)
      elements.push(element)
      return [name, element] as const
    }),
  )

  instances.push(instance)
  instance.executor.bind([...targets])

  return { instance, targets, errors }
}

function updateMode(instance: RuntimeAssembly, mode: string, options: { paused?: boolean } = {}) {
  instance.runtime.updateParameters({ mode })

  if (options.paused) {
    for (const animation of nativeEffects(instance.executor)) animation.pause()
  }
}

function invalidScaleEasing(source = definition) {
  return {
    ...source,
    layers: source.layers.map((layer) => ({
      ...layer,
      transitions: layer.transitions?.map((transition) => ({
        ...transition,
        transition: {
          ...transition.transition,
          targets: transition.transition.targets.map((target) => ({
            ...target,
            properties: target.properties.map((property) =>
              property.name === 'scale'
                ? {
                    ...property,
                    timing: { kind: 'tween' as const, durationMs: 100, easing: 'invalid' },
                  }
                : property,
            ),
          })),
        },
      })),
    })),
  }
}

const lifecyclePolicyDefinition: PropertyIRDefinition = {
  name: 'lifecycle-policy',
  parameters: [{ name: 'enabled', type: 'boolean' }],
  layers: [
    {
      name: 'base',
      targets: [
        { name: 'box', properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }] },
        { name: 'exit', properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }] },
      ],
    },
    {
      name: 'optional',
      when: { kind: 'reference', path: ['enabled'] },
      targets: [
        { name: 'box', properties: [{ name: 'width', value: { kind: 'literal', value: '50px' } }] },
      ],
    },
  ],
  enter: {
    timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
    targets: [
      {
        name: 'box',
        properties: [
          { name: 'opacity', keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }] },
          { name: 'width', keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }] },
        ],
      },
    ],
  },
  leave: {
    timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
    targets: [
      {
        name: 'exit',
        properties: [
          { name: 'opacity', keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }] },
        ],
      },
    ],
  },
}

function startRegisteredLifecycle(
  instance: RuntimeAssembly,
  phase: 'enter' | 'leave',
  target: string,
) {
  const session = new PresenceOperation(capturePresence(instance, phase, [target]), phase)
  session.initialize()
  session.initialize()
  session.play()

  return session
}

function capturedLeaveEffect(instance: RuntimeAssembly) {
  const previous = new Set(nativeEffects(instance.executor))
  const operation = new PresenceOperation(capturePresence(instance, 'leave', ['thumb']), 'leave')

  try {
    operation.play()

    const effect = nativeEffects(instance.executor).find(
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

  const { instance, targets, errors } = setup(source)
  // The toggle fixture declares thumb, and setup binds every declared target.
  const first = targets.get('thumb')!
  const second = document.createElement('div')
  first.tabIndex = 0
  first.style.opacity = '0.2'
  second.tabIndex = 0
  second.style.opacity = '0.8'

  document.body.append(second)
  elements.push(second)
  instance.executor.bind([...targets, ['thumb', second]])

  return { instance, targets, first, second, errors }
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.runtime.dispose()

  for (const element of elements.splice(0)) element.remove()
})

describe('browser animation execution', () => {
  it('releases ordinary native effects and logical callbacks when a call disposer fails', () => {
    const failure = new Error('Call disposal failed')
    const factory = vi.spyOn(functions, 'callBuiltin').mockReturnValue({
      value: 1,
      bind: () => () => {},
      prepareUpdate: () => ({ value: 1, commit() {}, discard() {} }),
      dispose() {
        throw failure
      },
    })
    const source = {
      ...definition,
      letBindings: [
        {
          name: 'value',
          initializer: { kind: 'call' as const, function: 'resource', arguments: [] },
        },
      ],
    }
    const { instance, targets } = setup(source)

    try {
      updateMode(instance, 'on', { paused: true })
      expect(nativeEffects(instance.executor).length).toBeGreaterThan(0)

      expect(() => instance.runtime.dispose()).toThrow(failure)

      expect(nativeEffects(instance.executor)).toEqual([])
      expect([...targets.values()].every((element) => element.getAnimations().length === 0)).toBe(
        true,
      )
      expect(instance.runtime.onEvent).toBeUndefined()
      expect(instance.runtime.onUpdate).toBeUndefined()
      expect(instance.runtime.isDisposed).toBe(true)
    } finally {
      factory.mockRestore()
    }
  })

  it('keeps captured detached leave functional after logical call disposal fails', async () => {
    const failure = new Error('Call disposal failed')
    const factory = vi.spyOn(functions, 'callBuiltin').mockReturnValue({
      value: 1,
      bind: () => () => {},
      prepareUpdate: () => ({ value: 1, commit() {}, discard() {} }),
      dispose() {
        throw failure
      },
    })
    const source = {
      ...definition,
      letBindings: [
        {
          name: 'value',
          initializer: { kind: 'call' as const, function: 'resource', arguments: [] },
        },
      ],
      leave: {
        timing: { kind: 'tween' as const, durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'thumb',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  { offset: 0, value: { kind: 'literal' as const, value: '1' } },
                  { offset: 1, value: { kind: 'literal' as const, value: '0' } },
                ],
              },
            ],
          },
        ],
      },
    }
    const { instance, targets } = setup(source)
    const captures = capturePresence(instance, 'leave', ['thumb'])

    try {
      expect(() => instance.runtime.dispose()).toThrow(failure)
      targets.get('thumb')!.remove()
      const leave = new PresenceOperation(captures, 'leave')
      leave.play()
      const effects = nativeEffects(instance.executor)

      expect(effects).toHaveLength(1)
      effects[0].finish()

      await expect(leave.finished).resolves.toBe('completed')

      expect(nativeEffects(instance.executor)).toEqual([])
      expect(targets.get('thumb')!.style.opacity).toBe('')
    } finally {
      factory.mockRestore()
    }
  })

  it('previews distinct properties through self and an alias of the same element', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const source: PropertyIRDefinition = {
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
    const { instance, targets, errors } = setup(source)
    const root = targets.get('self')!
    instance.executor.bind([
      ['self', root],
      ['alias', root],
    ])

    instance.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )

    await Promise.all(nativeEffects(instance.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 500

    expect(nativeEffects(instance.executor)).toHaveLength(2)
    expect(getComputedStyle(root).opacity).toBe('0.5')
    expect(getComputedStyle(root).width).toBe('20px')
    expect(errors).toEqual([])

    instance.executor.endCompositionPreview()

    expect(root.style.opacity).toBe('0')
    expect(root.style.width).toBe('10px')
  })

  it('uses each alias target cascade when expanding overlapping preview properties', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const source: PropertyIRDefinition = {
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
    const { instance, targets, errors } = setup(source)
    const root = targets.get('self')!
    root.style.position = 'relative'
    instance.executor.bind([
      ['self', root],
      ['alias', root],
    ])

    instance.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )

    await Promise.all(nativeEffects(instance.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 500

    expect(nativeEffects(instance.executor)).toHaveLength(8)
    expect(getComputedStyle(root).left).toBe('5px')
    expect(errors).toEqual([])

    instance.executor.endCompositionPreview()
  })

  it('preserves existing effects and composition when replacement preparation fails', () => {
    const { instance, errors } = setup()

    updateMode(instance, 'on', { paused: true })
    const previous = instance.runtime.composition
    const animations = [...nativeEffects(instance.executor)]

    expect(animations.length).toBeGreaterThan(0)

    const failure = new Error('native preparation failed')
    const prepare = vi.spyOn(window, 'KeyframeEffect').mockImplementationOnce(function () {
      throw failure
    })

    updateMode(instance, 'off')
    prepare.mockRestore()

    expect(instance.runtime.composition).toEqual(previous)
    expect(nativeEffects(instance.executor)).toEqual(animations)
    expect(animations.every((animation) => animation.playState === 'paused')).toBe(true)
    expect(errors.at(-1)?.code).toBe('runtime.expression')
    expect(errors.at(-1)?.error).toBe(failure)
  })

  it('captures a repeated target from its last accepted receiver', () => {
    const { instance, second, errors } = setupRepeatedThumb()

    const effect = capturedLeaveEffect(instance)

    expect(effect.target).toBe(second)
    expect(effect.getKeyframes()[0].opacity).toBe('0.8')
    expect(errors).toEqual([])
  })

  it.each(['reordered', 'repeated'] as const)(
    'preserves accepted receivers and effects for %s entries matching the unchanged check',
    (order) => {
      const { instance, targets, first, second, errors } = setupRepeatedThumb()

      updateMode(instance, 'on', { paused: true })
      const animations = nativeEffects(instance.executor)

      expect(animations.length).toBeGreaterThan(0)

      const entries: (readonly [string, HTMLElement])[] =
        order === 'reordered' ? [['thumb', second], ...targets] : [...targets, ['thumb', first]]

      instance.executor.bind(entries)

      expect(nativeEffects(instance.executor)).toEqual(animations)
      expect(capturedLeaveEffect(instance).target).toBe(second)
      expect(first.style.translate).toBe('24px')
      expect(second.style.translate).toBe('24px')
      expect(errors).toEqual([])
    },
  )

  it('rebuilds unbound receivers and completes new effects through aliases of the same element', async () => {
    const { instance, second, errors } = setupRepeatedThumb()

    updateMode(instance, 'on', { paused: true })
    const previous = [...nativeEffects(instance.executor)]

    expect(previous.length).toBeGreaterThan(0)

    instance.executor.bind([])

    expect(nativeEffects(instance.executor)).toEqual([])
    expect(previous.every((animation) => animation.playState === 'idle')).toBe(true)

    instance.executor.bind([
      ['thumb', second],
      ['track', second],
    ])
    updateMode(instance, 'off', { paused: true })
    const replacements = [...nativeEffects(instance.executor)]
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

    expect(nativeEffects(instance.executor)).toEqual([])
    expect(Number.parseFloat(getComputedStyle(second).translate)).toBe(0)
    expect(errors).toEqual([])
  })

  it('connects reactive calls to the last receiver and reconnects when that receiver is removed', async () => {
    const { instance, targets, first, second, errors } = setupRepeatedThumb()
    const focused = vi.fn<(name: string) => void>()
    instance.runtime.onEvent = focused

    first.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).not.toHaveBeenCalled()

    second.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).toHaveBeenCalledExactlyOnceWith('focus')

    instance.executor.bind([...targets])
    focused.mockClear()
    first.focus()

    await new Promise(requestAnimationFrame)

    expect(focused).toHaveBeenCalledExactlyOnceWith('focus')
    expect(second.style.translate).toBe('')
    expect(errors).toEqual([])
  })

  it.each(['enter', 'leave'] as const)(
    'does not observe unused ordinary addresses during %s previews',
    async (phase) => {
      const source: PropertyIRDefinition = {
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
      const { instance, targets, errors } = setup(source)
      const element = targets.get('box')
      const unrelated = targets.get('unrelated')

      expect(element).toBeDefined()
      expect(unrelated).toBeDefined()

      const observe = vi.spyOn(window, 'getComputedStyle')
      let reads: number
      let unrelatedReads: number

      try {
        instance.inspection.previewLifecycle(phase)
        reads = observe.mock.calls.length
        unrelatedReads = observe.mock.calls.filter(([receiver]) => receiver === unrelated).length
      } finally {
        observe.mockRestore()
      }

      await Promise.all(nativeEffects(instance.executor).map((animation) => animation.ready))

      for (const animation of nativeEffects(instance.executor)) animation.currentTime = 100

      // Only the phase's opacity can need a displayed snapshot; ordinary lengths
      // and the target without phase tracks require no writing-context observation.
      expect(reads).toBeLessThanOrEqual(1)
      expect(unrelatedReads).toBe(0)
      expect(getComputedStyle(element!).opacity).toBe('0.5')
      expect(errors).toEqual([])

      instance.executor.endCompositionPreview()
    },
  )

  it('scrubs canonical preview tracks with the same overlapping-property ownership as playback', async () => {
    const tween = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
    const source: PropertyIRDefinition = {
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
    const { instance, targets, errors } = setup(source)
    const element = targets.get('box')

    expect(element).toBeDefined()

    instance.inspection.previewComposition(
      { layers: { base: true, active: false }, states: {} },
      { layers: { base: true, active: true }, states: {} },
    )
    await Promise.all(nativeEffects(instance.executor).map((animation) => animation.ready))

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 500

    expect(nativeEffects(instance.executor)).toHaveLength(4)
    expect(getComputedStyle(element!).left).toBe('15px')
    expect(getComputedStyle(element!).right).toBe('5px')

    instance.executor.endCompositionPreview()

    expect(element!.style.left).toBe('20px')
    expect(nativeEffects(instance.executor)).toEqual([])
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
    const { instance } = setup(source)
    const observe = vi.spyOn(window, 'getComputedStyle')

    try {
      for (let update = 0; update < 10; update++) instance.runtime.updateParameters({})

      expect(observe).not.toHaveBeenCalled()
      expect(nativeEffects(instance.executor)).toEqual([])
    } finally {
      observe.mockRestore()
    }
  })

  it('plays compiled explicit self properties on the root with their shared timing', async () => {
    const source = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { instance, targets, errors } = setup(source, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    instance.runtime.updateParameters({ active: true })
    const animation = nativeEffects(instance.executor)[0]

    expect(nativeEffects(instance.executor)).toHaveLength(1)
    expect(animation.effect?.getTiming().duration).toBe(150)

    animation.pause()
    animation.currentTime = 75

    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(1)
    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('scrubs compiled self lifecycle timing without leaking to shorthand endpoints', () => {
    const source = decodeBundle(JSON.stringify(selfFixture)).definitions[0]
    const { instance, targets } = setup(source, { active: false })
    const root = targets.get('self')

    expect(root).toBeDefined()

    instance.inspection.previewLifecycle('enter', {
      layers: { base: true, interaction: false },
      states: {},
    })

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 100

    // Default tween easing is ease, so use actual effect timings rather than assume linear interpolation.
    expect(
      nativeEffects(instance.executor)
        .map((animation) => Number(animation.effect?.getTiming().duration))
        .toSorted((a, b) => a - b),
    ).toEqual([200, 400])
    expect(Number(getComputedStyle(root!).opacity)).toBeGreaterThan(0)
    expect(Number(getComputedStyle(root!).scale)).toBeGreaterThan(0.8)

    instance.executor.endCompositionPreview()

    expect(getComputedStyle(root!).opacity).toBe('1')
    expect(getComputedStyle(root!).scale).toBe('1')
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
    const { instance, targets } = setup(source)

    instance.executor.bind([])
    instance.runtime.replaceDefinition(source)
    instance.runtime.updateParameters({})

    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(targets.get('body')!.style.opacity).toBe('')

    instance.executor.bind([...targets])

    expect(targets.get('body')!.style.opacity).toBe('1')
  })

  it('keeps rejected duplicates suspended when replacement adds lifecycle support until rebinding', () => {
    const { instance, targets, errors } = setup()
    // setup binds every target declared by the toggle fixture, including thumb.
    const thumb = targets.get('thumb')!
    const duplicate = [...targets, ['thumb', thumb] as const]

    instance.executor.bind(duplicate)
    instance.runtime.replaceDefinition({ ...definition, enter: { targets: [] } })
    updateMode(instance, 'on')

    expect(thumb.style.translate).toBe('')
    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(errors).toEqual([
      expect.objectContaining({ code: 'runtime.targets', message: 'Duplicate target binding' }),
    ])

    instance.executor.bind(duplicate)

    expect(thumb.style.translate).toBe('24px')
  })

  it('interpolates a paused transition and restores owned styles on disposal', () => {
    const { instance, targets, errors } = setup()
    const thumb = targets.get('thumb')!

    updateMode(instance, 'on', { paused: true })
    expect(nativeEffects(instance.executor).length).toBeGreaterThan(0)

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 100

    expect(parseFloat(getComputedStyle(thumb).scale)).toBeGreaterThan(1)
    expect(errors).toEqual([])

    instance.runtime.dispose()

    expect(nativeEffects(instance.executor)).toEqual([])
    expect(thumb.style.scale).toBe('')
    updateMode(instance, 'off')

    instance.executor.bind([...targets])
    instance.runtime.replaceDefinition(definition)
    instance.runtime.updateParameters({ mode: 'on' })
  })

  it('completes animations and settles destination styles', async () => {
    const { instance, targets } = setup()

    updateMode(instance, 'on')

    const animations = [...nativeEffects(instance.executor)]

    await Promise.all(animations.map((animation) => animation.ready))

    for (const animation of animations) animation.finish()

    await Promise.all(animations.map((animation) => animation.finished))
    await Promise.resolve()

    expect(nativeEffects(instance.executor)).toEqual([])
    expect(targets.get('thumb')!.style.scale).toBe('1')
    updateMode(instance, 'on')
  })

  it('handles interruption, rebinding and invalid parameters without losing the composition', () => {
    const { instance, targets, errors } = setup()

    updateMode(instance, 'on', { paused: true })

    const first = nativeEffects(instance.executor)[0]

    first.currentTime = 100
    updateMode(instance, 'off', { paused: true })

    expect(first.playState).toBe('idle')
    instance.runtime.updateParameters({ mode: false })
    expect(instance.runtime.composition.states.toggle).toBe('off')
    expect(errors.at(-1)?.code).toBe('runtime.parameter')

    instance.executor.bind([...targets])

    expect(nativeEffects(instance.executor).length).toBeGreaterThan(0)

    instance.executor.bind([])

    expect(nativeEffects(instance.executor)).toEqual([])
    expect(errors.at(-1)?.message).toBe('Missing target binding')
    updateMode(instance, 'on')

    instance.executor.bind([...targets, ['thumb', targets.get('thumb')!]])

    expect(errors.at(-1)?.message).toBe('Duplicate target binding')

    instance.executor.bind([...targets])

    expect(targets.get('thumb')!.style.scale).toBe('1')
  })

  it('preserves external style edits and original declarations', () => {
    const { instance, targets } = setup()

    instance.runtime.dispose()

    const thumb = targets.get('thumb')!

    thumb.style.cssText = 'scale: 2 !important; color: red; margin: 4px'

    const replacement = assembleRuntime(definition, { mode: 'off' })

    instances.push(replacement)
    replacement.executor.bind([...targets])
    thumb.style.color = 'blue'
    thumb.style.removeProperty('margin')
    replacement.runtime.dispose()

    expect(thumb.style.scale).toBe('2')
    expect(thumb.style.getPropertyPriority('scale')).toBe('important')
    expect(thumb.style.color).toBe('blue')
    expect(thumb.style.margin).toBe('')
  })

  it('rejects invalid initial string choices before creating an instance', () => {
    const source = decodeBundle(JSON.stringify(constrainedFixture)).definitions[0]

    for (const position of ['middle', false]) {
      expect(() => assembleRuntime(source, { position, axis: 'x' })).toThrow(
        'Motion parameter position requires "end" | "start"',
      )
    }
  })

  it('commits constrained updates atomically and retains their derived presentation on failure', () => {
    const source = decodeBundle(JSON.stringify(constrainedFixture)).definitions[0]
    const { instance, targets, errors } = setup(source, { position: 'end', axis: 'x' })
    const thumb = targets.get('thumb')

    expect(thumb?.style.opacity).toBe('0.25')
    expect(thumb?.style.getPropertyValue('--position')).toBe('end')

    instance.runtime.updateParameters({ position: 'start', axis: 'x' })

    expect(thumb?.style.opacity).toBe('1')
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')

    instance.runtime.updateParameters({ position: 'end', axis: 'y' })
    instance.runtime.replaceDefinition(structuredClone(source))

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(thumb?.style.opacity).toBe('1')
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')
    expect(thumb?.style.getPropertyValue('--axis')).toBe('x')

    instance.runtime.updateParameters({ position: 'end', axis: 'x' })

    expect(thumb?.style.opacity).toBe('0.25')
    expect(thumb?.style.getPropertyValue('--position')).toBe('end')
  })

  it('rejects incompatible string constraints on replacement without changing the live definition', () => {
    const source = decodeBundle(JSON.stringify(constrainedFixture)).definitions[0]
    const { instance, targets } = setup(source, { position: 'start', axis: 'x' })
    const replacement = {
      ...source,
      parameters: [
        { name: 'position', type: { kind: 'stringUnion' as const, values: ['end'] } },
        { name: 'axis', type: { kind: 'stringUnion' as const, values: ['x'] } },
      ],
    }
    const thumb = targets.get('thumb')

    expect(() => instance.runtime.replaceDefinition(replacement)).toThrow(
      'Motion parameter position requires "end"',
    )
    expect(instance.runtime.definition).toBe(source)
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')
    expect(thumb?.style.opacity).toBe('1')

    instance.runtime.updateParameters({ position: 'end', axis: 'x' })

    expect(thumb?.style.getPropertyValue('--position')).toBe('end')
    expect(thumb?.style.opacity).toBe('0.25')
  })

  it('updates reactive parameters and retains them through definition replacement', () => {
    const reactive = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
    const { instance, errors } = setup(reactive, { checked: false })

    instance.runtime.updateParameters({ checked: true })

    expect(instance.runtime.composition.states.toggle).toBe('on')

    instance.runtime.replaceDefinition(structuredClone(reactive))

    expect(instance.runtime.composition.states.toggle).toBe('on')

    instance.runtime.updateParameters({ checked: 'invalid' })

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(instance.runtime.composition.states.toggle).toBe('on')

    instance.runtime.updateParameters({ checked: false })

    expect(instance.runtime.composition.states.toggle).toBe('off')
  })
})

it('updates template values in place and recovers from non-finite expressions', async () => {
  const templated = {
    name: 'size',
    parameters: [{ name: 'x', type: 'number' } as const],

    layers: [
      {
        name: 'idle',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'width',
                value: {
                  kind: 'template',
                  parts: [
                    {
                      kind: 'binary',
                      operator: '/',
                      left: { kind: 'number', value: 100 },
                      right: { kind: 'reference', path: ['x'] },
                    },
                    'px',
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies import('../model/definition.ts').Definition
  const { instance, targets, errors } = setup(templated, { x: 1 })

  instance.runtime.updateParameters({ x: 0 })

  expect(errors.at(-1)?.code).toBe('runtime.expression')

  const enter = new PresenceOperation(capturePresence(instance, 'enter', []), 'enter')

  enter.initialize()
  instance.runtime.updateParameters({ x: 2 })

  expect(enter.isFinished).toBe(false)

  enter.play()

  expect(await enter.finished).toBe('completed')
  expect(targets.get('box')!.style.width).toBe('50px')

  instance.runtime.updateParameters({ x: 2 })

  expect(targets.get('box')!.style.width).toBe('50px')

  instance.runtime.updateParameters({ x: 0 })

  expect(errors.at(-1)?.code).toBe('runtime.expression')
  expect(targets.get('box')!.style.width).toBe('50px')
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
  document.body.append(element)
  elements.push(element)

  const instance = assembleRuntime(def)

  instances.push(instance)
  instance.executor.bind([['box', element]])
  element.style.width = '20px'
  element.style.removeProperty('color')
  instance.runtime.dispose()

  expect(element.style.margin).toBe('var(--a)')
  expect(element.style.width).toBe('20px')
  expect(element.style.getPropertyPriority('width')).toBe('')
  expect(element.style.color).toBe('')

  const second = assembleRuntime(def)

  instances.push(second)
  second.executor.bind([['box', element]])
  element.style.setProperty('margin', 'var(--external)', 'important')
  second.runtime.dispose()

  expect(element.style.margin).toBe('var(--external)')
  expect(element.style.getPropertyPriority('margin')).toBe('important')
})

it('skips zero-duration layer effects', () => {
  const base = {
    name: 'fade',
    parameters: [{ name: 'mode', type: 'string' as const }],
    layers: ['off', 'on'].map((name) => ({
      name,
      when: {
        kind: 'binary' as const,
        operator: '==',
        left: { kind: 'reference' as const, path: ['mode'] },
        right: { kind: 'string' as const, value: name },
      },
      timing: { kind: 'tween' as const, durationMs: 0, easing: 'linear' },
      targets: [
        {
          name: 'box',
          properties: [
            {
              name: 'opacity',
              value: { kind: 'literal', value: name === 'off' ? '0' : '1' },
            },
          ],
        },
      ],
    })),
  } satisfies PropertyIRDefinition
  const { instance, targets } = setup(base)

  updateMode(instance, 'on')

  expect(nativeEffects(instance.executor)).toEqual([])
  expect(targets.get('box')!.style.opacity).toBe('1')
})

it('settles enter and leave together when reduced motion becomes active', async () => {
  const { instance, targets, errors } = setup(lifecyclePolicyDefinition, { enabled: true })
  const enter = startRegisteredLifecycle(instance, 'enter', 'box')
  const leave = startRegisteredLifecycle(instance, 'leave', 'exit')
  const media: CDPSession = cdp()

  try {
    await media.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    expect(await enter.finished).toBe('completed')
    expect(await leave.finished).toBe('completed')
    expect(targets.get('exit')!.getAnimations()).toHaveLength(0)
    expect(targets.get('box')!.style.opacity).toBe('1')
    expect(targets.get('box')!.style.width).toBe('50px')
    expect(errors).toEqual([])
  } finally {
    leave.cancel('owner-teardown')

    await media.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
  }
})

it('reports asynchronous enter settlement failures after the native session completes', async () => {
  const { instance, targets, errors } = setup(lifecyclePolicyDefinition, { enabled: true })
  const enter = new PresenceOperation(
    capturePresence(instance, 'enter', ['box']),
    'enter',
    () => {},
  )
  enter.initialize()
  enter.play()

  const failure = new Error('Failed to apply lifecycle settlement')
  const write = vi.spyOn(targets.get('box')!.style, 'setProperty').mockImplementationOnce(() => {
    throw failure
  })

  try {
    for (const animation of targets.get('box')!.getAnimations()) animation.finish()

    expect(await enter.finished).toBe('completed')

    await new Promise(requestAnimationFrame)

    expect(errors).toEqual([expect.objectContaining({ code: 'runtime.animation', error: failure })])
  } finally {
    write.mockRestore()
  }
})

it('plans enter completion restoration of removed declarations without cancelling a concurrent leave', async () => {
  const { instance, targets, errors } = setup(lifecyclePolicyDefinition, { enabled: true })
  const enter = startRegisteredLifecycle(instance, 'enter', 'box')
  const leave = startRegisteredLifecycle(instance, 'leave', 'exit')
  const box = targets.get('box')!

  try {
    instance.runtime.updateParameters({ enabled: false })

    for (const animation of box.getAnimations()) animation.finish()

    expect(await enter.finished).toBe('completed')
    expect(box.style.width).toBe('')
    expect(box.style.opacity).toBe('1')
    expect(leave.isFinished).toBe(false)
    expect(errors).toEqual([])
  } finally {
    leave.cancel('owner-teardown')
  }
})

it('settles active effects when reduced motion is enabled but preserves manual previews', async () => {
  const { instance, targets } = setup()

  updateMode(instance, 'on')

  const session: CDPSession = cdp()

  try {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await new Promise(requestAnimationFrame)

    await expect.poll(() => nativeEffects(instance.executor).length).toBe(0)
    expect(targets.get('thumb')!.style.translate).toBe('24px')

    instance.inspection.previewComposition(
      { layers: {}, states: { toggle: 'on' } },
      { layers: {}, states: { toggle: 'off' } },
      [{ layer: 'toggle', index: 1 }],
    )

    expect(nativeEffects(instance.executor).length).toBeGreaterThan(0)

    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })

    await new Promise(requestAnimationFrame)

    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await new Promise(requestAnimationFrame)

    expect(nativeEffects(instance.executor).length).toBeGreaterThan(0)
  } finally {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })

    await new Promise(requestAnimationFrame)
  }
})

it('releases only captured effects and keeps leave ownership through ordinary updates', async () => {
  const source = {
    ...definition,
    leave: {
      timing: { kind: 'tween' as const, durationMs: 1000, easing: 'linear' },
      targets: [
        {
          name: 'thumb',
          properties: [
            {
              name: 'translate',
              keyframes: [{ offset: 1, value: { kind: 'literal' as const, value: '0px' } }],
            },
          ],
        },
      ],
    },
  }
  const { instance, targets } = setup(source)

  updateMode(instance, 'on', { paused: true })

  const before = [...nativeEffects(instance.executor)]
  const unrelated = before.find(
    (animation) =>
      animation.effect instanceof KeyframeEffect &&
      animation.effect.target === targets.get('track'),
  )
  const session = new PresenceOperation(capturePresence(instance, 'leave', ['thumb']), 'leave')

  try {
    session.initialize()

    expect(nativeEffects(instance.executor)).toContain(unrelated)
    expect(nativeEffects(instance.executor).length).toBeLessThan(before.length)

    session.play()

    const leave = nativeEffects(instance.executor).find((animation) => !before.includes(animation))

    updateMode(instance, 'off', { paused: true })

    expect(nativeEffects(instance.executor)).toContain(leave)
    expect(session.isFinished).toBe(false)
  } finally {
    session.cancel('owner-teardown')
  }

  expect(await session.finished).toBe('owner-teardown')
})

it('restores parameter snapshots when a reactive transition cannot be prepared', () => {
  const def = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
  const broken = {
    ...def,
    layers: def.layers.map((layer) => ({
      ...layer,
      transitions: layer.transitions?.map((transition) => ({
        ...transition,
        transition: {
          targets: [],
          timing: { kind: 'tween' as const, durationMs: 100, easing: 'invalid' },
        },
      })),
    })),
  }
  const { instance, errors } = setup(broken, { checked: false })

  instance.runtime.updateParameters({ checked: true })

  expect(errors.at(-1)?.code).toBe('runtime.expression')
  expect(instance.runtime.composition.states.toggle).toBe('off')
})

it('stops a reactive update when an event listener disposes its owner', () => {
  const base = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
  const def = {
    ...base,
    events: [{ name: 'dismiss', when: { kind: 'reference', path: ['checked'] } as const }],
  }
  const { instance } = setup(def, { checked: false })

  instance.runtime.onEvent = () => instance.runtime.dispose()
  instance.runtime.updateParameters({ checked: true })

  expect(nativeEffects(instance.executor)).toEqual([])
  updateMode(instance, 'on')
})

it.each(['dispose', 'replace', 'presence'] as const)(
  'ignores a queued animation completion after %s',
  async (operation) => {
    const { instance, targets } = setup({
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

    updateMode(instance, 'on')

    const animation = nativeEffects(instance.executor)[0]

    await animation.ready
    animation.finish()

    const finished = animation.finished

    if (operation === 'dispose') instance.runtime.dispose()
    else if (operation === 'replace') instance.runtime.replaceDefinition(definition)
    else {
      presence = new PresenceOperation(capturePresence(instance, 'leave', ['track']), 'leave')
      presence.initialize()
    }

    targets.get('track')!.style.backgroundColor = 'blue'

    await finished

    await Promise.resolve()

    expect(nativeEffects(instance.executor)).not.toContain(animation)
    expect(targets.get('track')!.style.backgroundColor).toBe('blue')

    presence?.cancel('owner-teardown')
  },
)

it('cleans drag subscriptions and reports a failed reevaluation during disposal', async () => {
  const card = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
  const def = {
    ...card,
    letBindings: [
      ...card.letBindings!,
      {
        name: 'ratio',
        initializer: {
          kind: 'binary',
          operator: '/',
          left: { kind: 'number', value: 1 },
          right: {
            kind: 'binary',
            operator: '+',
            left: { kind: 'reference', path: ['movement', 'offset', 'x'] },
            right: { kind: 'number', value: 1 },
          },
        },
      } as const,
    ],
  }
  const { instance, targets, errors } = setup(def, {})
  const body = targets.get('body')!

  body.style.cssText =
    'position:fixed;left:100px;top:20px;width:20px;height:20px;z-index:1;touch-action:none'

  const destination = document.createElement('div')

  destination.style.cssText = 'position:fixed;left:99px;top:20px;width:20px;height:20px'
  document.body.append(destination)
  elements.push(destination)
  await userEvent.dragAndDrop(body, destination, { force: true })

  expect(errors).toContainEqual(expect.objectContaining({ code: 'runtime.expression' }))

  const count = errors.length

  instance.runtime.dispose()

  expect(errors.length).toBeGreaterThan(count)
  expect(nativeEffects(instance.executor)).toEqual([])
})

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
  const { instance, targets } = setup(def, { checked: false, x: 10 })

  const empty = new PresenceOperation(capturePresence(instance, 'enter', ['box']), 'enter')

  empty.play()

  expect(nativeEffects(instance.executor)).toEqual([])

  instance.runtime.updateParameters({ checked: true, x: 10 })

  expect(nativeEffects(instance.executor)).toHaveLength(3)

  const previous = [...nativeEffects(instance.executor)]

  instance.runtime.updateParameters({ checked: true, x: 20 })

  expect(nativeEffects(instance.executor)).toHaveLength(3)
  expect(
    previous.filter((animation) => nativeEffects(instance.executor).includes(animation)),
  ).toHaveLength(2)
  expect(targets.get('box')!.style.width).toBe('20px')
})

it('restores removed owned declarations but preserves external removals', () => {
  const element = document.createElement('div')

  element.style.cssText = 'width: 10px; height: 10px'
  document.body.append(element)
  elements.push(element)

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
  const instance = assembleRuntime(def)

  instances.push(instance)
  instance.executor.bind([['box', element]])

  expect(element.style.width).toBe('')

  element.style.removeProperty('height')
  instance.runtime.dispose()

  expect(element.style.width).toBe('10px')
  expect(element.style.height).toBe('')
})

it('retains enter snapshots on input changes and cancels them on owner disposal', async () => {
  const { instance } = setup()
  const interrupted = new PresenceOperation(capturePresence(instance, 'enter', []), 'enter')

  interrupted.initialize()
  instance.runtime.updateParameters({ mode: 'on' })

  expect(instance.runtime.composition.states.toggle).toBe('on')
  expect(interrupted.isFinished).toBe(false)

  interrupted.play()

  expect(await interrupted.finished).toBe('completed')

  const disposed = new PresenceOperation(capturePresence(instance, 'enter', []), 'enter')

  disposed.initialize()
  instance.runtime.dispose()

  expect(await disposed.finished).toBe('owner-teardown')
})

it('updates template snapshots while lifecycle targets are absent', () => {
  const def = {
    name: 'missing',
    parameters: [{ name: 'x', type: 'number' } as const],
    enter: { targets: [] },
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
                  kind: 'template',
                  parts: [{ kind: 'reference', path: ['x'] } as const, 'px'],
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies PropertyIRDefinition
  const { instance, errors } = setup(def, { x: 1 })

  instance.executor.bind([])
  instance.runtime.updateParameters({ x: 2 })

  expect(instance.runtime.composition.layers.off).toBe(true)
  expect(errors).toEqual([])
})

it('cancels effects prepared before a later track fails browser validation', () => {
  const broken = invalidScaleEasing()

  const { instance, errors } = setup(broken)

  updateMode(instance, 'on')
  expect(instance.runtime.composition.states.toggle).toBe('off')
  expect(nativeEffects(instance.executor)).toEqual([])
  expect(errors.at(-1)?.code).toBe('runtime.expression')
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
    const { instance, targets, errors } = setup(def, { opacity: 0.2 })
    const second = document.createElement('div')
    document.body.append(second)
    elements.push(second)
    instance.executor.bind([
      ['body', targets.get('body')!],
      ['body', second],
    ])

    instance.inspection.previewLifecycle(phase)
    expect(nativeEffects(instance.executor)).toHaveLength(2)

    for (const animation of nativeEffects(instance.executor)) animation.currentTime = 100

    for (const element of [targets.get('body')!, second]) {
      expect(Number(getComputedStyle(element).opacity)).toBeCloseTo(0.6)
      expect(element.isConnected).toBe(true)
    }

    instance.runtime.replaceDefinition(def)

    expect(nativeEffects(instance.executor)).toHaveLength(0)
    expect(getComputedStyle(second).opacity).toBe('1')
    expect(errors).toEqual([])

    instance.runtime.dispose()
    expect(() => instance.inspection.previewLifecycle(phase)).toThrow('mounted')
  },
)

it('keeps lifecycle preview preparation atomic on invalid easing and supports spring scrubbing', () => {
  const def = {
    name: 'panel',
    layers: [
      {
        name: 'off',
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
              {
                name: 'scale',
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
    leave: {
      timing: { kind: 'spring-duration' as const, durationMs: 200, bounce: 0.2 },
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'opacity',
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
            {
              name: 'scale',
              timing: { kind: 'tween' as const, durationMs: 200, easing: 'invalid' },
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '0.5',
                  },
                  easing: 'invalid',
                },
              ],
            },
          ],
        },
      ],
    },
  } satisfies PropertyIRDefinition
  const { instance, targets, errors } = setup(def)

  expect(() => instance.inspection.previewLifecycle('leave')).toThrow(
    'Could not prepare composition preview',
  )
  expect(targets.get('body')!.getAnimations()).toHaveLength(0)
  expect(errors.at(-1)?.code).toBe('runtime.preview')

  const valid = {
    ...def,
    leave: {
      ...def.leave,
      targets: [{ name: 'body', properties: [def.leave.targets[0].properties[0]] }],
    },
  }
  instance.runtime.replaceDefinition(valid)

  instance.inspection.previewLifecycle('leave')
  expect(nativeEffects(instance.executor)).toHaveLength(1)
})
