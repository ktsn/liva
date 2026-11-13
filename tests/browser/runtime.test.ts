import type { Definition as PropertyIRDefinition } from '../../packages/runtime/src/model/definition.ts'
import { test, expect } from '@playwright/test'
import type * as Runtime from '../../packages/runtime/src/index.ts'

declare global {
  interface Window {
    liva: typeof Runtime
    definition: Runtime.Definition
    errors: Runtime.RuntimeDiagnostic[]
    instance: Runtime.LivaInstance
    sibling: Runtime.LivaInstance
    track: HTMLElement
    thumb: HTMLElement
  }
}

const numbers = (text: string) => text.match(/-?\d*\.?\d+/g)!.map(Number)

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate(() => {
    const track = document.createElement('div')
    const thumb = document.createElement('div')
    track.style.cssText = 'width:100px;height:30px;background-color:rgb(1, 2, 3)'
    thumb.style.cssText = 'width:20px;height:20px'
    track.append(thumb)
    document.querySelector('#fixture')!.append(track)
    const instance = new window.liva.LivaInstance(window.definition, { mode: 'off' }, (error) =>
      window.errors.push(error),
    )
    Object.assign(window, { track, thumb, instance })
    instance.bind([
      ['track', track],
      ['thumb', thumb],
    ])
  })
})

test('interpolates three properties, coordinates time, and cleans completed effects', async ({
  page,
  browser,
}) => {
  console.log(`Browser baseline ${browser.browserType().name()} ${browser.version()}`)
  const result = await page.evaluate(async () => {
    const { instance, track, thumb } = window
    instance.updateParameters({ mode: 'on' })
    await Promise.all(instance.animations.map((a) => a.ready))
    const starts = instance.animations.map((a) => a.startTime)

    for (const animation of instance.animations) {
      animation.pause()
      animation.currentTime = 100
    }

    const sampled = {
      color: getComputedStyle(track).backgroundColor,
      translate: getComputedStyle(thumb).translate,
      scale: getComputedStyle(thumb).scale,
    }
    const effects = [...instance.animations]
    effects.forEach((a) => a.finish())
    await Promise.all(effects.map((a) => a.finished))
    await Promise.resolve()
    return {
      starts,
      sampled,
      final: getComputedStyle(thumb).translate,
      remaining: track.getAnimations({ subtree: true }).length,
    }
  })

  expect(new Set(result.starts).size).toBe(1)
  expect(result.sampled.color).not.toBe('rgb(136, 136, 136)')
  expect(parseFloat(result.sampled.translate)).toBeGreaterThan(0)
  expect(parseFloat(result.sampled.translate)).toBeLessThan(24)
  expect(parseFloat(result.sampled.scale)).toBeGreaterThan(1)
  expect(parseFloat(result.final)).toBe(24)
  expect(result.remaining).toBe(0)
})

test('spring overshoot is evaluated by the browser', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const original = window.definition
    const definition: Runtime.Definition = {
      ...original,
      layers: original.layers.map((layer) => ({
        ...layer,
        targets: layer.targets.map((target) => ({
          ...target,
          properties: target.properties.map((property) =>
            target.name === 'thumb' && property.name === 'translate'
              ? {
                  ...property,
                  timingExpression: undefined,
                  timing: { kind: 'spring-physics' as const, stiffness: 300, damping: 10, mass: 1 },
                }
              : property,
          ),
        })),
      })),
    }
    window.instance.replaceDefinition(definition)
    window.instance.updateParameters({ mode: 'on' })
    await Promise.all(window.instance.animations.map((a) => a.ready))
    const curve = window.liva.sampleSpring({
      kind: 'spring-physics',
      stiffness: 300,
      damping: 10,
      mass: 1,
    })
    const peak = curve.samples.reduce((a, b) => (a.value > b.value ? a : b))
    const animation = window.instance.animations.find(
      (a) =>
        a.effect instanceof KeyframeEffect &&
        a.effect.target === window.thumb &&
        'translate' in a.effect.getKeyframes()[0],
    )!
    animation.pause()
    animation.currentTime = peak.time * curve.durationMs
    return {
      actual: parseFloat(getComputedStyle(window.thumb).translate),
      expected: 24 * peak.value,
    }
  })

  expect(result.actual).toBeGreaterThan(30)
  expect(result.actual).toBeCloseTo(result.expected, 1)
})

for (const progress of [0.25, 0.5, 0.75]) {
  test(`reversal at ${progress} preserves displayed values`, async ({ page }) => {
    const result = await page.evaluate(async (fraction) => {
      const { instance, thumb, track } = window
      instance.updateParameters({ mode: 'on' })
      await Promise.all(instance.animations.map((a) => a.ready))

      for (const animation of instance.animations) {
        animation.pause()
        animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction
      }

      const read = () => [
        getComputedStyle(thumb).translate,
        getComputedStyle(thumb).scale,
        getComputedStyle(track).backgroundColor,
      ]
      const before = read()
      instance.updateParameters({ mode: 'off' })
      for (const animation of instance.animations) {
        animation.pause()
        animation.currentTime = 0
      }
      const after = read()
      const effects = [...instance.animations]
      effects.forEach((a) => a.finish())
      await Promise.all(effects.map((a) => a.finished))
      await Promise.resolve()
      return { before, after, remaining: instance.animations.length, final: read() }
    }, progress)

    result.before.forEach((value, i) => {
      const a = numbers(value)
      const b = numbers(result.after[i])
      expect(a.length).toBe(b.length)
      a.forEach((number, j) => expect(Math.abs(number - b[j])).toBeLessThan(i === 2 ? 1.1 : 0.03))
    })
    expect(result.remaining).toBe(0)
    expect(parseFloat(result.final[0])).toBe(0)
  })
}

test('parameter updates preserve instance isolation, binding suspension, and style ownership', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { instance, thumb, track } = window
    const initial = instance.animations.length
    instance.updateParameters({ mode: 'off' })
    const noop = instance.animations.length
    instance.updateParameters({ mode: false })
    const state = instance.composition.states.toggle
    const siblingThumb = thumb.cloneNode()
    const siblingTrack = track.cloneNode()
    if (!(siblingThumb instanceof HTMLElement) || !(siblingTrack instanceof HTMLElement)) {
      throw new Error('Expected cloned HTML targets')
    }
    siblingTrack.append(siblingThumb)
    document.body.append(siblingTrack)
    const sibling = new window.liva.LivaInstance(window.definition, { mode: 'off' })
    sibling.bind([
      ['track', siblingTrack],
      ['thumb', siblingThumb],
    ])
    instance.updateParameters({ mode: 'on' })
    const independent =
      sibling.animations.length === 0 && sibling.composition.states.toggle === 'off'
    instance.bind([['track', track]])
    const suspended = instance.animations.length
    instance.bind([
      ['track', track],
      ['thumb', thumb],
    ])
    const rebound = getComputedStyle(thumb).translate
    instance.bind([
      ['track', track],
      ['thumb', thumb],
      ['thumb', siblingThumb],
    ])
    instance.dispose()
    sibling.dispose()
    return {
      initial,
      noop,
      state,
      independent,
      suspended,
      rebound,
      restored: track.style.backgroundColor,
      errors: window.errors.map((e) => e.code),
      effects: document.getAnimations().length,
    }
  })

  expect(result).toMatchObject({
    initial: 0,
    noop: 0,
    state: 'off',
    independent: true,
    suspended: 0,
    restored: 'rgb(1, 2, 3)',
    effects: 0,
  })
  expect(parseFloat(result.rebound)).toBe(24)
  expect(result.errors).toEqual(['runtime.parameter', 'runtime.targets', 'runtime.targets'])
})

test('reduced motion changes settle immediately', async ({ page }) => {
  await page.evaluate(() => window.instance.updateParameters({ mode: 'on' }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  expect(await page.evaluate(() => parseFloat(getComputedStyle(window.thumb).translate))).toBe(24)
  await page.evaluate(() => window.instance.updateParameters({ mode: 'off' }))
  expect(await page.evaluate(() => window.instance.animations.length)).toBe(0)
})

test('zero duration settles synchronously', async ({ page }) => {
  const result = await page.evaluate(() => {
    const definition: Runtime.Definition = {
      name: 'zero',
      parameters: [{ name: 'mode', type: 'string' }],
      layers: [
        {
          name: 'base',
          timing: { kind: 'tween', durationMs: 0, easing: 'linear' },
          targets: [
            {
              name: 'track',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'template',
                    parts: [{ kind: 'reference', path: ['mode'] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    window.instance.updateParameters({ mode: '0' })
    window.instance.replaceDefinition(definition)
    window.instance.updateParameters({ mode: '1' })

    return { value: window.track.style.opacity, effects: window.instance.animations.length }
  })

  expect(result).toEqual({ value: '1', effects: 0 })
})

test('WAAPI exceptions retain a usable instance', async ({ page }) => {
  const result = await page.evaluate(() => {
    const targetName = window.definition.layers[0].targets[0].name
    const make = (easing: string): Runtime.Definition => ({
      name: 'failure',
      parameters: [{ name: 'mode', type: 'string' }],
      layers: [
        {
          name: 'base',
          timing: { kind: 'tween', durationMs: 300, easing },
          targets: [
            {
              name: targetName,
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'template',
                    parts: [{ kind: 'reference', path: ['mode'] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    window.instance.updateParameters({ mode: '0' })
    window.instance.replaceDefinition(make('invalid-easing'))
    window.instance.updateParameters({ mode: '1' })

    const count = document.getAnimations().length

    window.instance.replaceDefinition(make('linear'))
    window.instance.updateParameters({ mode: '1' })

    const recovered = window.instance.animations.length > 0

    window.instance.dispose()

    return { count, recovered, errors: window.errors.map((error) => error.code) }
  })

  expect(result).toEqual({ count: 0, recovered: true, errors: ['runtime.expression'] })
})

test('opaque CSS reaches the adapter', async ({ page }) => {
  const result = await page.evaluate(() => {
    const values: Record<string, string> = {
      'unknown-property': 'nonsense',
      '--offset': '10px',
      margin: '10px',
      transform: 'translateX(10px)',
      translate: '10px',
      offset: 'none',
      easing: 'nonsense',
      composite: 'nonsense',
    }
    const definition: Runtime.Definition = {
      name: 'opaque',
      parameters: [{ name: 'mode', type: 'string' }],
      layers: ['off', 'on'].map((name) => ({
        name,
        when: {
          kind: 'binary',
          operator: '==',
          left: { kind: 'reference', path: ['mode'] },
          right: { kind: 'string', value: name },
        },
        timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
        targets: [
          {
            name: 'track',
            properties: Object.keys(values).map((property) => ({
              name: property,
              value: {
                kind: 'literal',
                value: name === 'off' ? 'initial' : values[property],
              },
            })),
          },
        ],
      })),
    }

    window.instance.replaceDefinition(definition)
    window.instance.updateParameters({ mode: 'on' })

    const count = window.instance.animations.length

    window.instance.dispose()

    return { count, errors: window.errors.map((error) => error.code) }
  })

  expect(result).toEqual({ count: 8, errors: [] })
})

for (const [easing, expected] of [
  ['ease-in', 0.1577],
  ['cubic-bezier(0.42, 0, 1, 1)', 0.1577],
  ['steps(2, end)', 0.25],
  ['linear(0, .2 50%, 1)', 0.1],
] as const) {
  test(`tweens apply ${easing} to each keyframe interval`, async ({ page }) => {
    const result = await page.evaluate(async (intervalEasing) => {
      const definition: Runtime.Definition = {
        name: 'interval',
        parameters: [{ name: 'mode', type: 'string' }],
        layers: ['off', 'on'].map((name) => ({
          name,
          when: {
            kind: 'binary',
            operator: '==',
            left: { kind: 'reference', path: ['mode'] },
            right: { kind: 'string', value: name },
          },
          timing: { kind: 'tween', durationMs: 1000, easing: intervalEasing },
          targets: [
            {
              name: 'track',
              properties: [
                {
                  name: 'opacity',
                  value:
                    name === 'on'
                      ? {
                          kind: 'keyframes',
                          frames: [
                            { offset: 0.5, value: { kind: 'literal', value: '0.5' } },
                            { offset: 1, value: { kind: 'literal', value: '1' } },
                          ],
                        }
                      : { kind: 'literal', value: '0' },
                },
              ],
            },
          ],
        })),
      }

      window.instance.replaceDefinition(definition)
      window.instance.updateParameters({ mode: 'on' })
      await Promise.all(window.instance.animations.map((animation) => animation.ready))

      const animation = window.instance.animations[0]

      animation.pause()
      animation.currentTime = 250

      const snapshot = {
        value: Number(getComputedStyle(window.track).opacity),
        effectEasing: animation.effect!.getTiming().easing,
      }

      window.instance.dispose()

      return snapshot
    }, easing)

    expect(result.effectEasing).toBe('linear')
    expect(result.value).toBeCloseTo(expected, 2)
  })
}

test('keyframe easing applies to the outgoing interval only', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const definition: Runtime.Definition = {
      name: 'outgoing',
      parameters: [{ name: 'mode', type: 'string' }],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'track',
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
          name: 'active',
          when: {
            kind: 'binary',
            operator: '==',
            left: { kind: 'reference', path: ['mode'] },
            right: { kind: 'string', value: 'on' },
          },
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          targets: [
            {
              name: 'track',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'keyframes',
                    frames: [
                      {
                        offset: 0,
                        value: {
                          kind: 'literal',
                          value: '0',
                        },
                        easing: 'step-start',
                      },
                      {
                        offset: 0.5,
                        value: {
                          kind: 'literal',
                          value: '0.5',
                        },
                      },
                      {
                        offset: 1,
                        value: {
                          kind: 'literal',
                          value: '1',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    window.instance.replaceDefinition(definition)
    window.instance.updateParameters({ mode: 'on' })

    await Promise.all(window.instance.animations.map((animation) => animation.ready))

    const animation = window.instance.animations[0]

    animation.pause()
    animation.currentTime = 250

    const firstInterval = Number(getComputedStyle(window.track).opacity)

    animation.currentTime = 750

    const secondInterval = Number(getComputedStyle(window.track).opacity)

    window.instance.dispose()

    return { firstInterval, secondInterval }
  })

  expect(result.firstInterval).toBeCloseTo(0.5, 2)
  expect(result.secondInterval).toBeCloseTo(0.75, 2)
})

test('definition replacement preserves duplicate suspension and disposal respects external styles', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { instance, track, thumb, definition } = window
    const extra = document.createElement('div')
    document.body.append(extra)
    instance.bind([
      ['track', track],
      ['thumb', thumb],
      ['thumb', extra],
    ])
    instance.replaceDefinition(definition)
    instance.updateParameters({ mode: 'on' })
    const suspended = instance.animations.length
    instance.bind([
      ['track', track],
      ['thumb', thumb],
    ])
    track.style.backgroundColor = 'rgb(9, 8, 7)'
    instance.dispose()
    return {
      suspended,
      retained: track.style.backgroundColor,
      effects: document.getAnimations().length,
    }
  })

  expect(result).toEqual({ suspended: 0, retained: 'rgb(9, 8, 7)', effects: 0 })
})

test('restores shorthand side effects and overlapping longhands with priorities', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const element = document.createElement('div')
    element.style.setProperty('margin-left', '5px', 'important')
    document.body.append(element)
    const definition = {
      name: 'a',
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
                    value: '10px',
                  },
                },
                {
                  name: 'margin-left',
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
    const instance = new window.liva.LivaInstance(definition, {})
    instance.bind([['box', element]])
    instance.dispose()
    return {
      css: element.style.cssText,
      value: element.style.marginLeft,
      priority: element.style.getPropertyPriority('margin-left'),
      right: element.style.marginRight,
    }
  })

  expect(result.value).toBe('5px')
  expect(result.priority).toBe('important')
  expect(result.right).toBe('')
})

test('restores variable shorthands without overwriting unrelated external edits', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const element = document.createElement('div')
    element.style.cssText = 'margin: var(--gap); width: 12px; color: red'
    document.body.append(element)
    const definition = {
      name: 'a',
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
                    value: '10px',
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies PropertyIRDefinition
    const instance = new window.liva.LivaInstance(definition, {})
    instance.bind([['box', element]])
    element.style.width = '20px'
    element.style.removeProperty('color')
    instance.dispose()
    return { margin: element.style.margin, width: element.style.width, color: element.style.color }
  })

  expect(result).toEqual({ margin: 'var(--gap)', width: '20px', color: '' })
})

test('tracks pending shorthand substitutions and retains external priority removal', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const element = document.createElement('div')
    element.style.cssText = 'margin: var(--a); width: 12px !important'
    document.body.append(element)
    const definition = {
      name: 'a',
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
    const instance = new window.liva.LivaInstance(definition, {})
    instance.bind([['box', element]])
    instance.dispose()
    const restored = element.style.margin
    const second = new window.liva.LivaInstance(definition, {})
    second.bind([['box', element]])
    element.style.width = '20px'
    second.dispose()
    return {
      restored,
      margin: element.style.margin,
      width: element.style.width,
      priority: element.style.getPropertyPriority('width'),
    }
  })

  expect(result).toEqual({ restored: 'var(--a)', margin: 'var(--a)', width: '20px', priority: '' })
})
