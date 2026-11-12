import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { canonicalTracks, decodeProperty, propertyAddresses } from './property-codec.ts'
import { PropertyMotion } from './property-motion.ts'

const elements: HTMLElement[] = []
const physics = { kind: 'spring-physics', stiffness: 100, damping: 12, mass: 1 } as const

function target() {
  const element = document.createElement('div')
  element.style.cssText = 'width:100px;height:80px;translate:0px 0px;'
  document.body.append(element)
  elements.push(element)

  return element
}

afterEach(() => {
  vi.restoreAllMocks()

  for (const element of elements.splice(0)) {
    for (const animation of element.getAnimations()) animation.cancel()
    element.remove()
  }
})

describe('property motion ownership contracts', () => {
  it.each([
    ['translate', ['translate.x', 'translate.y', 'translate.z']],
    ['scale', ['scale.x', 'scale.y', 'scale.z']],
    ['rotate', ['rotate']],
    ['opacity', ['opacity']],
    ['inline-size', ['width']],
    ['inset-inline-end', ['right']],
    ['background-color', ['background-color']],
  ])('identifies canonical addresses for %s', (property, addresses) => {
    const element = target()

    expect(propertyAddresses(element, property)).toEqual(addresses)
  })

  it.each([
    ['translate', [0, 0, 0]],
    ['scale', [1, 1, 1]],
  ])('decodes the default %s as an identity', (property, values) => {
    const element = target()
    element.style.setProperty(property, 'none')

    expect(decodeProperty(element, property)?.values).toEqual(values)
  })

  it('splits physical inset tracks without mixing the four side destinations', () => {
    const element = target()
    const track = {
      target: 'self',
      property: 'inset',
      destinationValue: '10px 20px 30px 40px',
      timing: physics,
      keyframes: [{ offset: 0, value: '1px 2px 3px 4px' }],
    }

    expect(
      canonicalTracks(element, track).map((entry) => [entry.property, entry.destinationValue]),
    ).toEqual([
      ['top', '10px'],
      ['right', '20px'],
      ['bottom', '30px'],
      ['left', '40px'],
    ])
  })

  it.each([
    ['width', '200px', '100px'],
    ['translate', '10px 20px', '3px 4px'],
    ['background-color', 'red', 'blue'],
  ])(
    'retains an unexpanded %s track without changing authored frames',
    (property, destinationValue, value) => {
      const element = target()
      const track = {
        target: 'self',
        property,
        destinationValue,
        timing: physics,
        keyframes: [{ offset: 0, value }],
      }

      expect(canonicalTracks(element, track)).toEqual([track])
    },
  )

  it.each(['hidden', 'detached'] as const)('does not observe an unreadable %s target', (state) => {
    const element = target()
    const motion = new PropertyMotion()

    if (state === 'hidden') element.style.display = 'none'
    else element.remove()

    expect(decodeProperty(element, 'translate')).toBeUndefined()
    expect(motion.read(element, 'translate')).toBeUndefined()
    expect(motion.prepareSpring(element, 'translate', '100px', physics, true)).toBeUndefined()

    motion.beginControl(element, 'translate', 10)
    motion.record(element, 'translate', 10)
    const animation = new Animation()
    motion.register(element, 'translate', animation)

    element.style.display = 'block'
    document.body.append(element)

    expect(motion.read(element, 'translate', 20)?.velocity).toEqual([0, 0, 0])
  })

  it('starts a direct-control session at rest and expires stationary observations', () => {
    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 0)
    element.style.translate = '20px 0px'
    motion.record(element, 'translate', 20)

    expect(motion.read(element, 'translate', 20)?.velocity).toEqual([1, 0, 0])

    motion.beginControl(element, 'translate', 30)

    expect(motion.read(element, 'translate', 30)?.velocity).toEqual([0, 0, 0])

    element.style.translate = '30px 0px'
    motion.record(element, 'translate', 40)
    motion.record(element, 'translate', 130)

    expect(motion.read(element, 'translate', 130)?.velocity).toEqual([0, 0, 0])
  })

  it('preserves protected effects when recording direct writes to other owned properties', () => {
    const element = target()
    const motion = new PropertyMotion()
    const animation = element.animate([{ translate: '0px' }, { translate: '100px' }], {
      duration: 1000,
      fill: 'both',
    })
    animation.pause()
    animation.currentTime = 200
    motion.register(element, 'translate', animation)

    motion.record(element, 'translate', 200, new Set(propertyAddresses(element, 'translate')))

    expect(motion.read(element, 'translate', 200)?.velocity[0]).toBeCloseTo(0.1, 4)
  })

  it('starts fresh after a changed value arrives beyond the direct sample window', () => {
    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 0)
    element.style.translate = '20px 0px'
    motion.record(element, 'translate', 20)

    element.style.translate = '40px 0px'
    motion.record(element, 'translate', 120)

    expect(motion.read(element, 'translate', 120)?.velocity).toEqual([0, 0, 0])
  })

  it('keeps analytic spring velocity until the native effect finishes', () => {
    // Recorded samples and prepareSpring's clock must share the same time origin.
    vi.spyOn(performance, 'now').mockReturnValue(20)

    const element = target()
    const motion = new PropertyMotion()
    motion.record(element, 'translate', 0)
    element.style.translate = '20px 0px'
    motion.record(element, 'translate', 20)
    const spring = motion.prepareSpring(element, 'translate', '100px 0px', physics, true)
    if (!spring) throw new Error('Expected a spring handoff')
    const animation = element.animate(spring.frames, { duration: spring.durationMs, fill: 'both' })
    animation.pause()
    animation.currentTime = 50
    motion.register(element, 'translate', animation, spring.sample)

    expect(motion.read(element, 'translate')?.velocity).toEqual(spring.sample(50).velocity)

    animation.finish()

    expect(motion.read(element, 'translate')?.velocity).toEqual([0, 0, 0])
  })

  it('keeps ordinary interpolation at rest and rejects undecodable spring destinations', () => {
    const element = target()
    const motion = new PropertyMotion()

    expect(motion.prepareSpring(element, 'translate', '100px', physics, true)).toBeUndefined()
    expect(motion.prepareSpring(element, 'width', 'auto', physics, true)).toBeUndefined()
    expect(motion.prepareSpring(element, 'width', '50%', physics, true)?.frames).toBeDefined()
  })
})
