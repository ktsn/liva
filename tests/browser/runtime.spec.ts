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
    const instance = new window.liva.LivaInstance(window.definition, 'off', (error) =>
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
    instance.setState('on')
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
    const definition = structuredClone(window.definition) as any
    definition.generalTransition.targets[1].properties[0].timing.damping = 10
    window.instance.replaceDefinition(definition)
    window.instance.setState('on')
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
        (a.effect as KeyframeEffect).target === window.thumb &&
        'translate' in (a.effect as KeyframeEffect).getKeyframes()[0],
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
    const result = await page.evaluate(async (progress) => {
      const { instance, thumb, track } = window
      instance.setState('on')
      await Promise.all(instance.animations.map((a) => a.ready))

      for (const animation of instance.animations) {
        animation.pause()
        animation.currentTime = Number(animation.effect!.getTiming().duration) * progress
      }

      const read = () => [
        getComputedStyle(thumb).translate,
        getComputedStyle(thumb).scale,
        getComputedStyle(track).backgroundColor,
      ]
      const before = read()
      instance.setState('off')
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

    const numbers = (text: string) => text.match(/-?\d*\.?\d+/g)!.map(Number)
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

test('initial state, noops, invalid states, suspension, restoration, and independent instances', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { instance, thumb, track } = window
    const initial = instance.animations.length
    instance.setState('off')
    const noop = instance.animations.length
    const invalid = instance.setState('missing')
    const state = instance.state
    const siblingThumb = thumb.cloneNode() as HTMLElement
    const siblingTrack = track.cloneNode() as HTMLElement
    siblingTrack.append(siblingThumb)
    document.body.append(siblingTrack)
    const sibling = new window.liva.LivaInstance(window.definition, 'off')
    sibling.bind([
      ['track', siblingTrack],
      ['thumb', siblingThumb],
    ])
    instance.setState('on')
    const independent = sibling.animations.length === 0 && sibling.state === 'off'
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
      invalid,
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
    invalid: false,
    state: 'off',
    independent: true,
    suspended: 0,
    restored: 'rgb(1, 2, 3)',
    effects: 0,
  })
  expect(parseFloat(result.rebound)).toBe(24)
  expect(result.errors).toEqual(['runtime.state', 'runtime.targets', 'runtime.targets'])
})

test('reduced motion changes settle immediately', async ({ page }) => {
  await page.evaluate(() => window.instance.setState('on'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  expect(await page.evaluate(() => parseFloat(getComputedStyle(window.thumb).translate))).toBe(24)
  await page.evaluate(() => window.instance.setState('off'))
  expect(await page.evaluate(() => window.instance.animations.length)).toBe(0)
})

test('zero duration is synchronous and WAAPI exceptions leave a usable instance', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const make = (durationMs: number, easing: string) => ({
      name: 'a',
      states: [
        {
          name: 'off',
          targets: [{ name: 'track', properties: [{ name: 'opacity', value: '0' }] }],
        },
        { name: 'on', targets: [{ name: 'track', properties: [{ name: 'opacity', value: '1' }] }] },
      ],
      generalTransition: { timing: { kind: 'tween' as const, durationMs, easing }, targets: [] },
      directionalTransitions: [],
    })
    window.instance.replaceDefinition(make(0, 'linear'))
    window.instance.setState('on')
    const zero = { value: window.track.style.opacity, effects: window.instance.animations.length }
    window.instance.replaceDefinition(make(300, 'invalid-easing'), 'off')
    const invalid = window.instance.setState('on')
    const count = document.getAnimations().length
    window.instance.replaceDefinition(make(300, 'linear'))
    const recovered = window.instance.setState('on')
    window.instance.dispose()
    return { zero, invalid, count, recovered, errors: window.errors.map((e) => e.code) }
  })

  expect(result).toEqual({
    zero: { value: '1', effects: 0 },
    invalid: false,
    count: 0,
    recovered: true,
    errors: ['runtime.animation'],
  })
})

test('tweens use interval easing and opaque CSS reaches the adapter', async ({ page }) => {
  const result = await page.evaluate(async () => {
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
    const properties = Object.keys(values)
    const definition = {
      name: 'a',
      states: ['off', 'on'].map((name) => ({
        name,
        targets: [
          {
            name: 'track',
            properties: properties.map((property) => ({
              name: property,
              value: name === 'off' ? 'initial' : values[property],
            })),
          },
        ],
      })),
      generalTransition: {
        timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
        targets: [],
      },
      directionalTransitions: [],
    }
    window.instance.replaceDefinition(definition, 'off')
    const ok = window.instance.setState('on')
    const opaqueCount = window.instance.animations.length
    const easingResults = []

    for (const easing of [
      'ease-in',
      'cubic-bezier(0.42, 0, 1, 1)',
      'steps(2, end)',
      'linear(0, .2 50%, 1)',
    ]) {
      const def = {
        name: 'e',
        states: ['off', 'on'].map((name) => ({
          name,
          targets: [
            { name: 'track', properties: [{ name: 'opacity', value: name === 'off' ? '0' : '1' }] },
          ],
        })),
        generalTransition: {
          timing: { kind: 'tween' as const, durationMs: 1000, easing },
          targets: [
            {
              name: 'track',
              properties: [{ name: 'opacity', keyframes: [{ offset: 0.5, value: '0.5' }] }],
            },
          ],
        },
        directionalTransitions: [],
      }
      window.instance.replaceDefinition(def, 'off')
      window.instance.setState('on')
      await Promise.all(window.instance.animations.map((a) => a.ready))
      const animation = window.instance.animations[0]
      animation.pause()
      animation.currentTime = 250
      easingResults.push({
        value: Number(getComputedStyle(window.track).opacity),
        effectEasing: animation.effect!.getTiming().easing,
      })
    }

    window.instance.dispose()
    return { ok, opaqueCount, easingResults, errors: window.errors.map((e) => e.code) }
  })

  expect(result.ok).toBe(true)
  expect(result.opaqueCount).toBe(8)
  expect(result.errors).toEqual([])
  result.easingResults.forEach((r) => expect(r.effectEasing).toBe('linear'))
  expect(result.easingResults[0].value).toBeCloseTo(0.1577, 2)
  expect(result.easingResults[1].value).toBeCloseTo(0.1577, 2)
  expect(result.easingResults[2].value).toBeCloseTo(0.25, 2)
  expect(result.easingResults[3].value).toBeCloseTo(0.1, 2)
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
    instance.setState('on')
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
      states: [
        {
          name: 'on',
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'margin', value: '10px' },
                { name: 'margin-left', value: '20px' },
              ],
            },
          ],
        },
      ],
      directionalTransitions: [],
    }
    const instance = new window.liva.LivaInstance(definition, 'on')
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
      states: [
        { name: 'on', targets: [{ name: 'box', properties: [{ name: 'margin', value: '10px' }] }] },
      ],
      directionalTransitions: [],
    }
    const instance = new window.liva.LivaInstance(definition, 'on')
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
      states: [
        {
          name: 'on',
          targets: [{ name: 'box', properties: [{ name: 'margin', value: 'var(--b)' }] }],
        },
      ],
      directionalTransitions: [],
    }
    const instance = new window.liva.LivaInstance(definition, 'on')
    instance.bind([['box', element]])
    instance.dispose()
    const restored = element.style.margin
    const second = new window.liva.LivaInstance(definition, 'on')
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
