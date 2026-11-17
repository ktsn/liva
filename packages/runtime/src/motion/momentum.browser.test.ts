import { capturePresence } from '../__test__/helpers/presence.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LivaInstance, type RuntimeDiagnostic } from '../execution/instance.ts'
import type { Definition, Timing } from '../model/definition.ts'
import { PresenceOperation } from '../execution/presence-operation.ts'
import { PropertyMotion, springMotion } from './property-motion.ts'
import { decodeProperty } from './property-codec.ts'

const physics: Timing = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 }
const instances: LivaInstance[] = []
const elements: HTMLElement[] = []

function setup(
  property: string,
  destination: string,
  timing: Timing = physics,
  additional: Definition['layers'] = [],
) {
  const parent = document.createElement('div')
  parent.style.cssText = 'position:relative;width:400px;height:300px;'
  const element = document.createElement('div')
  element.style.cssText =
    'position:absolute;width:100px;height:80px;left:0;top:0;translate:0px 0px;'
  parent.append(element)
  document.body.append(parent)
  elements.push(parent)
  const errors: RuntimeDiagnostic[] = []
  const definition: Definition = {
    name: 'momentum',
    parameters: [{ name: 'enabled', type: 'boolean' }],
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: property,
                value: {
                  kind: 'literal',
                  value: property === 'inset' ? '0px' : property === 'width' ? '100px' : '0px 0px',
                },
                timing,
              },
            ],
          },
        ],
      },
      {
        name: 'active',
        when: { kind: 'reference', path: ['enabled'] },
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: property,
                value: {
                  kind: 'literal',
                  value: destination,
                },
                timing,
              },
            ],
          },
        ],
      },
      ...additional,
    ],
  }
  const instance = new LivaInstance(definition, { enabled: false }, (error) => errors.push(error))
  instances.push(instance)
  instance.bind([['self', element]])

  return { instance, element, parent, errors }
}

async function frames() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose()
  for (const element of elements.splice(0)) element.remove()
})

describe('displayed momentum integration', () => {
  it('hands ordinary velocity into leave and its spring trajectory back into re-entry', async () => {
    const timing = { kind: 'spring-physics', stiffness: 100, damping: 20, mass: 1 } as const
    const { instance, element, errors } = setup('translate', '100px', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })

    instance.replaceDefinition({
      ...instance.definition,
      enter: {
        timing,
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'translate',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }],
              },
            ],
          },
        ],
      },
      leave: {
        timing,
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'translate',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '200px' } }],
              },
            ],
          },
        ],
      },
    })
    instance.updateParameters({ enabled: true })

    const ordinary = element.getAnimations()[0]

    ordinary.pause()
    ordinary.currentTime = 250

    const observations = vi.spyOn(PropertyMotion.prototype, 'observeSpring')
    const leave = new PresenceOperation(capturePresence(instance, 'leave', ['self']), 'leave')
    let enter: PresenceOperation | undefined

    try {
      leave.initialize()
      leave.play()

      const outgoing = element.getAnimations()[0]

      outgoing.pause()
      outgoing.currentTime = 250

      const observation = observations.mock.results[0].value
      const displayedValue = decodeProperty(element, 'translate')?.values[0]
      const expected = springMotion(timing, [25, 0, 0], [200, 0, 0], [0.1, 0, 0]).sample(250)

      expect(observation.start?.value[0]).toBeCloseTo(25, 5)
      expect(observation.start?.velocity[0]).toBeCloseTo(0.1, 5)

      const work = capturePresence(instance, 'enter', ['self'], { interrupted: true })

      observations.mockClear()
      enter = new PresenceOperation(work, 'enter')
      enter.initialize(leave)
      enter.play()

      const incoming = element.getAnimations()[0]
      const reentry = observations.mock.results[0].value

      expect(reentry.start?.value[0]).toBe(displayedValue)
      expect(reentry.start?.velocity[0]).toBeCloseTo(expected.velocity[0], 5)

      incoming.finish()

      expect(await enter.finished).toBe('completed')
      expect(element.style.translate).toBe('100px')
      expect(errors).toEqual([])
    } finally {
      observations.mockRestore()
      leave.cancel('owner-teardown')
      enter?.cancel('owner-teardown')
    }
  })

  it('reports reconciliation failures even after the completed effect has been removed', async () => {
    const { instance, element, errors } = setup('width', '200px', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })
    instance.updateParameters({ enabled: true })
    const animations = [...instance.animations]
    const failure = new Error('Failed to write the accepted cascade')
    const write = vi.spyOn(element.style, 'setProperty').mockImplementationOnce(() => {
      throw failure
    })

    try {
      for (const animation of animations) animation.finish()

      await frames()

      expect(instance.animations).toEqual([])
      expect(errors).toEqual([
        expect.objectContaining({ code: 'runtime.animation', error: failure }),
      ])
    } finally {
      write.mockRestore()
    }
  })

  it.each([
    ['margin', '20px', 'margin-left', '40px', '40px'],
    ['background', 'blue', 'background-color', 'green', 'rgb(0, 128, 0)'],
  ])(
    'restores the winning %s longhand after shorthand completion',
    async (property, destination, longhand, value, expected) => {
      const { instance, element, errors } = setup(
        property,
        destination,
        {
          kind: 'tween',
          durationMs: 1000,
          easing: 'linear',
        },
        [
          {
            name: 'override',
            when: { kind: 'reference', path: ['enabled'] },
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    name: longhand,
                    value: { kind: 'literal', value },
                    timing: { kind: 'tween', durationMs: 0, easing: 'linear' },
                  },
                ],
              },
            ],
          },
        ],
      )
      instance.updateParameters({ enabled: true })
      const animations = [...instance.animations]

      for (const animation of animations) animation.finish()

      await Promise.all(animations.map((animation) => animation.finished))

      expect(getComputedStyle(element).getPropertyValue(longhand)).toBe(expected)
      expect(errors).toEqual([])
    },
  )

  it('reconciles a completed track without rewriting unrelated receiving elements', async () => {
    const { instance, element, errors } = setup('width', '200px', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })
    const other = document.createElement('div')
    other.style.cssText = 'width:100px;height:80px;'
    document.body.append(other)
    elements.push(other)
    const definition = instance.definition
    const layers = definition.layers.map((layer) => ({
      ...layer,
      targets: [...layer.targets, { ...layer.targets[0], name: 'other' }],
    }))
    instance.replaceDefinition({ ...definition, layers })
    instance.bind([
      ['self', element],
      ['other', other],
    ])
    instance.updateParameters({ enabled: true })
    const finished = instance.animations.find(
      (animation) =>
        animation.effect instanceof KeyframeEffect && animation.effect.target === element,
    )

    if (!finished) throw new Error('Expected an animation for the receiving element')

    const writes = vi.spyOn(other.style, 'setProperty')

    finished.finish()
    await finished.finished

    expect(writes).not.toHaveBeenCalled()
    expect(element.style.width).toBe('200px')
    expect(instance.animations).toHaveLength(1)
    expect(errors).toEqual([])

    writes.mockRestore()
  })

  it('reports reference-retarget failures with their original error and recovers on a later frame', async () => {
    const { instance, element, errors } = setup('translate', '100% 0px')
    instance.updateParameters({ enabled: true })
    const failure = new Error('Failed to sample replacement effect')
    const sampling = vi.spyOn(PropertyMotion.prototype, 'read').mockImplementationOnce(() => {
      throw failure
    })
    element.style.width = '200px'

    await frames()
    await frames()
    sampling.mockRestore()

    expect(errors).toEqual([expect.objectContaining({ code: 'runtime.animation', error: failure })])
    expect(instance.animations).toHaveLength(1)
  })

  it('retargets a reference changed immediately before effect completion', async () => {
    const { instance, element, errors } = setup('translate', '100% 0px')
    instance.updateParameters({ enabled: true })
    const first = instance.animations[0]
    element.style.width = '200px'

    first.finish()
    await first.finished
    await Promise.resolve()

    expect(instance.animations[0]).not.toBe(first)
    const replacement = instance.animations[0]
    replacement.pause()
    await frames()

    expect(instance.animations[0]).toBe(replacement)
    instance.dispose()
    await frames()

    expect(element.getAnimations()).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it('retargets a relative destination when its reference changes without a position jump', async () => {
    const { instance, element, errors } = setup('translate', '100% 0px')
    instance.updateParameters({ enabled: true })
    const first = instance.animations[0]
    first.pause()
    first.currentTime = 60
    const before = decodeProperty(element, 'translate')?.values[0]
    element.style.width = '200px'
    first.playbackRate = 0
    first.play()

    await frames()

    const replacement = instance.animations[0]
    expect(replacement).not.toBe(first)
    expect(first.playState).toBe('idle')
    replacement.pause()
    replacement.currentTime = 0
    expect(decodeProperty(element, 'translate')?.values[0]).toBeCloseTo(before ?? 0, 2)
    replacement.finish()
    await replacement.finished
    await frames()

    expect(decodeProperty(element, 'translate')?.values[0]).toBe(200)
    expect(element.style.translate).toBe('100%')
    expect(errors).toEqual([])
  })

  it('preserves independent inset ownership and restores authored shorthand units', async () => {
    const { instance, element, errors } = setup('inset', '10% 20%', physics, [
      {
        name: 'left',
        when: { kind: 'reference', path: ['enabled'] },
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'left',
                value: {
                  kind: 'literal',
                  value: '40px',
                },
              },
            ],
          },
        ],
      },
    ])

    instance.updateParameters({ enabled: true })

    expect(instance.animations).toHaveLength(3)
    expect(getComputedStyle(element).left).toBe('40px')
    const animations = [...instance.animations]
    for (const animation of animations) animation.finish()
    await Promise.all(animations.map((animation) => animation.finished))
    await frames()

    expect(getComputedStyle(element).top).toBe('30px')
    expect(getComputedStyle(element).right).toBe('80px')
    expect(getComputedStyle(element).left).toBe('40px')
    expect(errors).toEqual([])
  })

  it('preserves velocity and independent axes through repeated spring interruptions', () => {
    const { instance, element, errors } = setup('translate', '100px 200px')
    instance.updateParameters({ enabled: true })
    const first = instance.animations[0]
    first.pause()
    first.currentTime = 60
    const pose = decodeProperty(element, 'translate')?.values

    instance.updateParameters({ enabled: false })
    const second = instance.animations[0]
    second.pause()
    second.currentTime = 0

    expect(decodeProperty(element, 'translate')?.values[0]).toBeCloseTo(pose?.[0] ?? 0, 2)
    second.currentTime = 1
    const initial = decodeProperty(element, 'translate')?.values
    expect(initial?.[0]).toBeGreaterThan(pose?.[0] ?? 0)
    expect(initial?.[1]).toBeGreaterThan(pose?.[1] ?? 0)
    second.currentTime = 80

    instance.updateParameters({ enabled: true })

    expect(second.playState).toBe('idle')
    expect(instance.animations).toHaveLength(1)
    expect(first.playState).toBe('idle')
    expect(errors).toEqual([])
  })
})
