import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  decodeProperty,
  decodeDestination,
  canonicalTracks,
  propertyReference,
} from './property-codec.ts'
import { PropertyMotion } from './property-motion.ts'

const elements: HTMLElement[] = []

function target() {
  const parent = document.createElement('div')
  parent.style.cssText = 'position:relative;width:400px;height:300px;'
  const element = document.createElement('div')
  element.style.cssText =
    'position:absolute;box-sizing:border-box;width:100px;height:80px;top:0;right:0;bottom:0;left:0;translate:0px 0px;'
  parent.append(element)
  document.body.append(parent)
  elements.push(parent)

  return element
}

afterEach(() => {
  for (const element of elements.splice(0)) element.remove()
})

describe('canonical property codecs', () => {
  it.each(['width', 'height', 'inline-size', 'block-size'])(
    'bounds negative %s values only when requested by the caller',
    (property) => {
      const element = target()
      const decoded = decodeProperty(element, property)

      expect(decoded?.serialize([-10])).toBe('-10px')
      expect(decoded?.serialize([-10], true)).toBe('0px')
    },
  )

  it.each([
    [-0.1, '0'],
    [0.5, '0.5'],
    [1.2, '1'],
  ])('bounds opacity %s for both serialization modes', (value, expected) => {
    const decoded = decodeProperty(target(), 'opacity')

    expect(decoded?.serialize([value])).toBe(expected)
    expect(decoded?.serialize([value], true)).toBe(expected)
  })

  it('resolves logical dimensions in vertical flow and neutral rotation', () => {
    const element = target()
    element.style.writingMode = 'vertical-lr'
    element.style.direction = 'ltr'
    element.style.rotate = 'none'

    expect(decodeProperty(element, 'inline-size')?.addresses).toEqual(['height'])
    expect(decodeProperty(element, 'block-size')?.addresses).toEqual(['width'])
    expect(decodeProperty(element, 'inset-inline-start')?.addresses).toEqual(['top'])
    expect(decodeProperty(element, 'inset-block-start')?.addresses).toEqual(['left'])
    expect(decodeProperty(element, 'rotate')?.values).toEqual([0])
    expect(decodeProperty(element, 'width')?.serialize([-10], true)).toBe('0px')
    const split = canonicalTracks(element, {
      target: 'self',
      property: 'inline-size',
      destinationValue: '50%',
      timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
      keyframes: [],
    })
    expect(split[0].property).toBe('height')
    expect(split[0].destinationValue).toBe('50%')

    element.style.display = 'none'

    expect(propertyReference(element, 'width', '50%')).toBeDefined()

    element.style.position = 'fixed'

    expect(propertyReference(element, 'width', '50%')).toBeDefined()
    expect(propertyReference(document.documentElement, 'width', '50%')).toBeDefined()
  })

  it('preserves authored inset frame units and easing when splitting logical tracks', () => {
    const element = target()
    element.style.direction = 'rtl'
    const track = {
      target: 'self',
      property: 'inset-inline',
      destinationValue: '25% 2em',
      timing: { kind: 'tween', durationMs: 200, easing: 'linear' } as const,
      keyframes: [{ offset: 0.5, value: '10px 3rem', easing: 'ease-in' }],
    }

    const split = canonicalTracks(element, track)

    expect(split.map((entry) => [entry.property, entry.destinationValue])).toEqual([
      ['right', '25%'],
      ['left', '2em'],
    ])
    expect(split[0].keyframes).toEqual([{ offset: 0.5, value: '10px', easing: 'ease-in' }])
    expect(split[1].keyframes[0].value).toBe('3rem')
    expect(canonicalTracks(element, { ...track, destinationValue: 'var(--insets)' })).toEqual([
      { ...track, destinationValue: 'var(--insets)' },
    ])
    expect(
      canonicalTracks(element, { ...track, keyframes: [{ offset: 0.5, value: 'invalid' }] }),
    ).toEqual([{ ...track, keyframes: [{ offset: 0.5, value: 'invalid' }] }])
  })

  it('tracks relative reference changes without depending on unrelated properties', () => {
    const element = target()
    element.style.setProperty('--distance', '10px')
    const own = propertyReference(element, 'translate', '50%')
    const parent = propertyReference(element, 'left', '50%')
    const variable = propertyReference(element, 'translate', 'var(--distance)')

    element.style.width = '200px'

    expect(propertyReference(element, 'translate', '50%')).not.toBe(own)
    expect(propertyReference(element, 'left', '50%')).toBe(parent)

    element.style.setProperty('--distance', '30px')

    expect(propertyReference(element, 'translate', 'var(--distance)')).not.toBe(variable)
    expect(propertyReference(element, 'background-color', 'var(--color)')).toBeUndefined()
  })

  it.each([
    ['translate', 'calc(50% + 10px) 25%', [60, 20, 0]],
    ['scale', '1.5 0.5', [1.5, 0.5, 1]],
    ['rotate', '.5turn', [180]],
    ['opacity', '0.5', [0.5]],
    ['width', '50%', [200]],
    ['height', 'calc(50% - 10px)', [140]],
    ['inline-size', '10em', [160]],
    ['block-size', '2rem', [32]],
    ['inset', '10px 20px 30px 40px', [10, 20, 30, 40]],
    ['inset-inline', '10px 20px', [10, 20]],
    ['inset-block', '30px 40px', [30, 40]],
    ['inset-inline-start', '10px', [10]],
    ['translate', 'min(50%, 40px) max(10%, 15px)', [40, 15, 0]],
    ['translate', 'clamp(10px, 50%, 80px) calc(20% + 5px)', [50, 21, 0]],
    ['translate', 'calc(-20% + 5px) 0', [-15, 0, 0]],
    ['translate', 'calc(50% - 10px) calc(min(50%, 20px) / 2)', [40, 10, 0]],
    ['scale', '150%', [1.5, 1.5, 1]],
  ])('resolves %s: %s without rewriting authored styles', (property, value, expected) => {
    const element = target()
    const before = element.style.cssText
    const decoded = decodeDestination(element, property, value)

    expect(decoded?.values).toEqual(expected)
    expect(element.style.cssText).toBe(before)
    expect(element.getAnimations()).toHaveLength(0)
  })

  it('shares physical and logical inset addresses according to writing mode and direction', () => {
    const element = target()
    element.style.direction = 'rtl'

    expect(decodeProperty(element, 'inset-inline-start')?.addresses).toEqual(['right'])

    element.style.writingMode = 'vertical-rl'

    expect(decodeProperty(element, 'inset-block-start')?.addresses).toEqual(['right'])
    expect(decodeProperty(element, 'inset-inline-start')?.addresses).toEqual(['bottom'])
  })

  it('falls back for unsupported/discrete and unresolvable values', () => {
    const element = target()

    expect(decodeDestination(element, 'width', 'auto')).toBeUndefined()
    expect(decodeDestination(element, 'translate', 'invalid')).toBeUndefined()
    expect(decodeProperty(element, 'background-color')).toBeUndefined()

    element.style.rotate = 'x 20deg'

    expect(decodeProperty(element, 'rotate')).toBeUndefined()
  })
})

describe('per-property motion histories', () => {
  it('retains recent velocity across irregular samples while pruning expired history', () => {
    const element = target()
    const motion = new PropertyMotion()

    for (const time of [0, 20, 70, 100, 130]) {
      element.style.translate = `${time}px 0px`
      motion.record(element, 'translate', time)
    }

    expect(motion.read(element, 'translate', 140)?.velocity).toEqual([1, 0, 0])
    expect(motion.read(element, 'translate', 220)?.velocity).toEqual([0, 0, 0])
  })

  it('predicts terminal stationary input from recent history and expires stale or reversed clocks', () => {
    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 0)
    element.style.translate = '20px 0px'
    motion.record(element, 'translate', 20)

    expect(motion.predict(element, 'translate', [20, 0, 0], 30)?.velocity).toEqual([1, 0, 0])
    expect(motion.predict(element, 'translate', [20, 0, 0], 120)?.velocity).toEqual([0, 0, 0])

    element.style.translate = '10px 0px'
    motion.record(element, 'translate', 10)

    expect(motion.predict(element, 'translate', [10, 0, 0], 10)?.velocity).toEqual([0, 0, 0])
  })

  it('keeps unsupported values out of prediction and handoff and retains intermediate choreography', () => {
    const element = target()
    const motion = new PropertyMotion()

    expect(motion.read(element, 'background-color')).toBeUndefined()
    expect(motion.predict(element, 'background-color', [10], 10)).toBeUndefined()
    expect(motion.predict(element, 'translate', [10, 20, 0], 10)?.velocity).toEqual([0, 0, 0])
    expect(
      motion.prepareSpring(
        element,
        'translate',
        '100px 0px',
        {
          kind: 'spring-physics',
          stiffness: 300,
          damping: 25,
          mass: 1,
        },
        false,
      ),
    ).toBeUndefined()
  })

  it('reads running native motion without pausing playback and falls back for 3D rotation', () => {
    const element = target()
    const motion = new PropertyMotion()
    const animation = element.animate([{ translate: '0px' }, { translate: '100px' }], {
      duration: 1000,
      fill: 'both',
    })
    animation.pause()
    animation.currentTime = -10
    motion.register(element, 'translate', animation)

    expect(motion.read(element, 'translate')?.velocity).toEqual([0, 0, 0])

    animation.currentTime = 100
    animation.play()

    expect(motion.read(element, 'translate')?.velocity[0]).toBeCloseTo(0.1, 3)
    expect(animation.playState).toBe('running')

    animation.cancel()
    const rotation = element.animate([{ rotate: 'none' }, { rotate: 'x 30deg' }], {
      duration: 1000,
      fill: 'both',
    })
    rotation.pause()
    rotation.currentTime = 0
    motion.register(element, 'rotate', rotation)

    expect(motion.read(element, 'rotate')).toBeUndefined()

    rotation.cancel()
  })

  it('uses recent displayed samples, preserves direction changes, and releases a stationary hold at rest', () => {
    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 0)
    element.style.translate = '40px 20px'
    motion.record(element, 'translate', 20)

    expect(motion.read(element, 'translate', 20)?.velocity).toEqual([2, 1, 0])

    element.style.translate = '30px 30px'
    motion.record(element, 'translate', 30)

    expect(motion.read(element, 'translate', 30)?.velocity).toEqual([-1, 1, 0])
    expect(motion.read(element, 'translate', 111)?.velocity).toEqual([0, 0, 0])
  })

  it('does not divide by zero for coalesced samples and resets replacement sessions', () => {
    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 10)
    element.style.translate = '20px 0px'
    motion.record(element, 'translate', 10)

    expect(motion.read(element, 'translate', 10)?.velocity).toEqual([0, 0, 0])

    motion.reset()

    expect(motion.read(element, 'translate', 10)?.velocity).toEqual([0, 0, 0])
  })

  it('samples a paused native tween derivative for a spring handoff', () => {
    const element = target()
    const motion = new PropertyMotion()
    const animation = element.animate([{ translate: '0px 0px' }, { translate: '100px 200px' }], {
      duration: 1000,
      fill: 'both',
      easing: 'linear',
    })
    animation.pause()
    animation.currentTime = 400
    motion.register(element, 'translate', animation)

    const sample = motion.read(element, 'translate')

    expect(sample?.value).toEqual([40, 80, 0])
    expect(sample?.velocity[0]).toBeCloseTo(0.1, 4)
    expect(sample?.velocity[1]).toBeCloseTo(0.2, 4)
    expect(animation.playState).toBe('paused')
    expect(animation.currentTime).toBe(400)

    animation.cancel()
  })

  it('inherits internal opacity momentum while serializing bounded display values', () => {
    const element = target()
    element.style.opacity = '.9'
    const motion = new PropertyMotion()
    const now = performance.now()
    motion.record(element, 'opacity', now - 10)
    element.style.opacity = '1'
    motion.record(element, 'opacity', now)
    const spring = motion.prepareSpring(
      element,
      'opacity',
      '.5',
      { kind: 'spring-physics', stiffness: 100, damping: 8, mass: 1 },
      true,
    )

    expect(spring?.sample(1).velocity[0]).toBeGreaterThan(0)
    expect(
      spring?.frames.every((frame) => Number(frame.opacity) >= 0 && Number(frame.opacity) <= 1),
    ).toBe(true)
  })
})
