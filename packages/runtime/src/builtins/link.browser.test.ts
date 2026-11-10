import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { link } from './link.ts'
import { propertyController } from '../controllers.ts'
import { PropertyMotion } from '../property-motion.ts'
import { decodeProperty } from '../property-codec.ts'
import type { FunctionArguments, RuntimeValue } from '../reactive-value.ts'

const cleanups: (() => void)[] = []

function setup(property: string, input: RuntimeValue = 0, extra: FunctionArguments = {}) {
  const parent = document.createElement('div')
  parent.style.cssText = 'position:relative;width:400px;height:300px;'

  const element = document.createElement('div')
  element.style.cssText =
    'position:absolute;box-sizing:border-box;width:100px;height:80px;left:10px;top:30px;translate:100px 50px 7px;rotate:30deg;'
  if (property.includes('right') || property === 'inset-inline-end')
    element.style.cssText += 'left:auto;right:20px;'
  if (property.includes('bottom') || property === 'inset-block-end')
    element.style.cssText += 'top:auto;bottom:40px;'

  parent.append(element)
  document.body.append(parent)
  cleanups.push(() => parent.remove())

  const args = { input, ...extra }
  const call = link(args)
  const controller = propertyController(call.value)
  const motion = new PropertyMotion()
  const warnings: string[] = []

  controller.configure({
    target: 'self',
    property,
    motion,
    report: (message) => warnings.push(message),
  })

  let notifications = 0

  cleanups.push(
    call.bind(new Map([['self', element]]), () => {
      notifications++
    }),
  )

  const time = performance.now()
  controller.acquire(time)

  function update(nextInput: RuntimeValue, elapsed: number, next: FunctionArguments = {}) {
    const prepared = call.prepareUpdate(
      { ...args, input: nextInput, ...next },
      { time: time + elapsed },
    )

    prepared.commit()
    const controlled = controller.control()

    if (controlled) {
      element.style.setProperty(controlled.property, controlled.value)
      motion.record(element, controlled.property, time + elapsed)
    }

    return prepared.value
  }

  return {
    element,
    call,
    controller,
    motion,
    warnings,
    update,
    time,
    get notifications() {
      return notifications
    },
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()

  vi.restoreAllMocks()
})

describe('link property adapters', () => {
  it.each([
    ['width', '100px'],
    ['inline-size', '100px'],
    ['inset-inline-start', '10px'],
    ['rotate', '30deg'],
    ['translate', '100px 50px 7px'],
  ])('renders frozen %s observations without a connected target', (property, expected) => {
    const input = property === 'translate' ? { x: 0, y: 0 } : 0
    const binding = setup(property, input)

    binding.controller.setPreview(true)
    binding.controller.setPreview(true)
    binding.element.remove()

    expect(binding.controller.render(property, binding.call.value)).toBe(expected)

    binding.controller.setPreview(false)
  })

  it('reads mapped fallback while bound to a missing receiving target', () => {
    const call = link({ input: 10, component: 'x' })
    const controller = propertyController(call.value)
    cleanups.push(call.bind(new Map(), () => {}))

    controller.setPreview(true)
    controller.setPreview(false)

    expect(call.value).toMatchObject({ value: { x: 10, y: 0, z: 0 }, attached: false })
    expect(controller.render('translate', call.value)).toBeUndefined()
    expect(controller.render('translate', 1)).toBeUndefined()
  })

  it.each([
    ['width', 100],
    ['height', 80],
    ['inline-size', 100],
    ['block-size', 80],
    ['left', 10],
    ['right', 20],
    ['top', 30],
    ['bottom', 40],
    ['rotate', 30],
    ['inset-inline-start', 10],
    ['inset-inline-end', 20],
    ['inset-block-start', 30],
    ['inset-block-end', 40],
  ])('controls scalar %s in canonical units', (property, initial) => {
    const binding = setup(property)

    const snapshot = binding.update(20, 20)

    expect(snapshot).toMatchObject({ value: initial + 20, velocity: 1, attached: true })
    expect(decodeProperty(binding.element, property)?.values[0]).toBe(initial + 20)
    expect(binding.warnings).toEqual([])
  })

  it('maps a vector relatively while preserving the captured Z component', () => {
    const binding = setup('translate', { x: 10, y: 20 })

    const snapshot = binding.update({ x: 15, y: 10 }, 20)

    expect(snapshot).toMatchObject({ value: { x: 105, y: 40, z: 7 }, attached: true })
    expect(decodeProperty(binding.element, 'translate')?.values).toEqual([105, 40, 7])
  })

  it.each([
    { elapsed: 40, velocity: 1 },
    { elapsed: 100, velocity: 0 },
  ])('hands input velocity $velocity to motion history at release time $elapsed', (sample) => {
    const binding = setup('width')
    binding.update(20, 20)
    // A different displayed displacement must not replace the input derivative.
    binding.element.style.width = '150px'

    binding.controller.release(binding.time + sample.elapsed)

    expect(binding.motion.read(binding.element, 'width', binding.time + sample.elapsed)).toEqual({
      value: [150],
      velocity: [sample.velocity],
    })
  })

  it('starts a reacquired control session at rest despite a gesture input reset', () => {
    const binding = setup('translate', 0, { component: 'x' })
    binding.update(20, 20)
    binding.controller.release(binding.time + 20)
    binding.update(0, 30)

    binding.controller.acquire(binding.time + 30)

    expect(binding.call.readSnapshot?.({ time: binding.time + 30 })).toMatchObject({
      value: { x: 120, y: 50, z: 7 },
      velocity: { x: 0, y: 0, z: 0 },
    })

    const moved = binding.update(10, 40)

    expect(moved).toMatchObject({
      value: { x: 130, y: 50, z: 7 },
      velocity: { x: 1, y: 0, z: 0 },
    })
  })

  it('keeps the same controller capability across snapshots and aliases', () => {
    const binding = setup('translate', 0, { component: 'y' })
    const alias = binding.call.value

    const next = binding.update(20, 20)

    expect(propertyController(alias)).toBe(propertyController(next))
    expect(next).toMatchObject({ value: { x: 100, y: 70, z: 7 } })

    expect(() =>
      binding.controller.configure({
        target: 'other',
        property: 'translate',
        motion: new PropertyMotion(),
        report: () => {},
      }),
    ).toThrow('exactly one')

    expect(() =>
      binding.controller.configure({
        target: 'self',
        property: 'width',
        motion: new PropertyMotion(),
        report: () => {},
      }),
    ).toThrow('exactly one')
  })

  it('samples target absence and recovery on demand while tracking input velocity', () => {
    const binding = setup('translate', 0, { component: 'y', sensitivity: -2 })
    binding.element.style.display = 'none'

    expect(binding.call.readSnapshot?.({ time: binding.time })).toMatchObject({
      value: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      attached: false,
    })
    const nextTime = performance.now()
    const prepared = binding.call.prepareUpdate(
      { input: 10, component: 'y', sensitivity: -2 },
      { time: nextTime + 20 },
    )
    prepared.commit()

    expect(prepared.value).toMatchObject({ value: { x: 0, y: -20, z: 0 }, attached: false })
    expect(binding.controller.control()).toBeUndefined()

    binding.element.style.display = 'block'

    binding.controller.acquire(performance.now())

    expect(binding.call.readSnapshot?.({ time: performance.now() })).toMatchObject({
      value: { x: 100, y: 50, z: 7 },
      velocity: { x: 0, y: 0, z: 0 },
      attached: true,
    })
    expect(binding.controller.control()?.value).toBe('100px 50px 7px')
    expect(binding.warnings).toEqual([])
  })

  it('ends an unreadable committed session and rebases when control returns', () => {
    const binding = setup('width')
    binding.update(20, 20)

    binding.element.style.display = 'none'
    const hidden = binding.update(30, 30)

    expect(hidden).toMatchObject({ attached: false, velocity: 1 })
    expect(binding.call.value).toMatchObject({ attached: false, velocity: 1 })

    binding.element.style.display = 'block'
    binding.controller.acquire(binding.time + 50)

    expect(binding.controller.control()?.value).toBe('120px')

    const recovered = binding.update(40, 60)

    expect(recovered).toMatchObject({ attached: true, value: 130, velocity: 1 })
    expect(binding.element.style.width).toBe('130px')
  })

  it('retires a hidden session when preview publishes fallback before an input commit', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const binding = setup('width')
    binding.update(20, 20)

    binding.element.style.display = 'none'
    clock.mockReturnValue(125)
    binding.controller.setPreview(true)
    binding.update(30, 30)
    clock.mockReturnValue(140)
    binding.controller.setPreview(false)

    binding.element.style.display = 'block'
    binding.controller.acquire(150)

    expect(binding.controller.control()?.value).toBe('120px')
    expect(binding.update(40, 60)).toMatchObject({ value: 130, velocity: 1, attached: true })
  })

  it.each(['source recovery', 'preview exit'] as const)(
    "preserves another owner's registered motion during inactive %s",
    (transition) => {
      const binding = setup('width')
      binding.controller.release()

      const animation = binding.element.animate([{ width: '100px' }, { width: '200px' }], {
        duration: 1000,
        fill: 'both',
      })
      cleanups.push(() => animation.cancel())
      animation.pause()
      animation.currentTime = 200
      binding.motion.register(binding.element, 'width', animation, () => ({
        value: [120],
        velocity: [3],
      }))

      if (transition === 'source recovery') {
        binding.element.style.display = 'none'
        binding.call.readSnapshot?.({ time: binding.time })
        binding.element.style.display = 'block'
        binding.call.readSnapshot?.({ time: binding.time })
      } else {
        binding.controller.setPreview(true)
        binding.controller.setPreview(false)
      }

      expect(binding.controller.control()).toBeUndefined()
      expect(binding.motion.read(binding.element, 'width')?.velocity).toEqual([3])
    },
  )

  it('preserves the current session when a hidden-target preparation is discarded', () => {
    const binding = setup('width')
    binding.update(20, 20)

    binding.element.style.display = 'none'
    const abandoned = binding.call.prepareUpdate({ input: 30 }, { time: binding.time + 30 })
    abandoned.discard()
    binding.element.style.display = 'block'

    binding.update(30, 40)

    expect(binding.element.style.width).toBe('130px')
    expect(binding.controller.control()?.value).toBe('130px')
  })

  it('diagnoses unreadable values on demand once and recovers', () => {
    const binding = setup('rotate')
    binding.element.style.rotate = 'x 20deg'

    expect(binding.call.readSnapshot?.({ time: binding.time })).toMatchObject({
      value: 0,
      attached: false,
    })
    expect(binding.controller.control()).toBeUndefined()
    expect(binding.controller.control()).toBeUndefined()
    expect(binding.warnings).toHaveLength(1)

    binding.element.style.rotate = '40deg'

    expect(binding.call.readSnapshot?.({ time: binding.time })).toMatchObject({
      value: 40,
      velocity: 0,
      attached: true,
    })
  })

  it('freezes observations during manual preview and resumes on-demand reads afterwards', () => {
    const binding = setup('translate', 0, { component: 'x' })

    binding.controller.setPreview(true)
    binding.element.style.translate = '200px 50px 7px'

    expect(binding.call.readSnapshot?.({ time: performance.now() })).toMatchObject({
      value: { x: 100, y: 50, z: 7 },
    })
    expect(binding.controller.render('translate', binding.call.value)).toBe('100px 50px 7px')

    binding.controller.setPreview(false)

    expect(binding.call.readSnapshot?.({ time: binding.time })).toMatchObject({
      value: { x: 200, y: 50, z: 7 },
    })
  })

  it('discards invalid or abandoned argument updates without changing the active pose', () => {
    const binding = setup('width')
    const abandoned = binding.call.prepareUpdate({ input: 20 }, { time: binding.time + 20 })
    abandoned.discard()

    expect(binding.controller.control()?.value).toBe('100px')
    expect(() => binding.call.prepareUpdate({ input: -200 })).toThrow('invalid property')
    expect(() => binding.call.prepareUpdate({ input: Infinity })).toThrow('finite')
    expect(() => binding.call.prepareUpdate({ input: 1, component: 'x' })).toThrow('fixed')
    expect(binding.controller.control()?.value).toBe('100px')
  })

  it('rebases sensitivity at the displayed pose while preserving unmapped axes', () => {
    const binding = setup('translate', 0, { component: 'x' })

    binding.controller.acquire(binding.time + 1)
    binding.update(20, 20)
    const rebased = binding.update(20, 30, { sensitivity: 2 })
    const moved = binding.update(25, 40, { sensitivity: 2 })

    expect(rebased).toMatchObject({ value: { x: 120, y: 50, z: 7 } })
    expect(moved).toMatchObject({ value: { x: 130, y: 50, z: 7 } })
  })

  it('releases control and disposes observation resources idempotently', () => {
    const binding = setup('width')

    binding.update(20, 20)

    binding.controller.release()

    expect(binding.controller.control()).toBeUndefined()

    binding.call.dispose()
    binding.call.dispose()

    expect(binding.call.value).toMatchObject({ value: 20, attached: false })
    expect(binding.controller.control()).toBeUndefined()
  })

  it('never schedules frames or notifications for binding, input changes, or animation', async () => {
    const request = vi.spyOn(window, 'requestAnimationFrame')
    const binding = setup('width')
    binding.update(20, 20)
    binding.controller.release(binding.time + 20)
    const animation = binding.element.animate([{ width: '120px' }, { width: '200px' }], {
      duration: 100,
      fill: 'both',
    })
    cleanups.push(() => animation.cancel())

    await animation.finished

    expect(request).not.toHaveBeenCalled()
    expect(binding.notifications).toBe(0)
    expect(binding.call.readSnapshot?.({ time: binding.time + 200 })).toMatchObject({
      value: 200,
      velocity: 0,
    })
  })

  it.each(['dispose', 'rebind'] as const)(
    'honors %s from the first binding diagnostic',
    (action) => {
      const element = document.createElement('div')
      element.style.cssText = 'width:100px;height:50px;rotate:x 20deg;'
      const replacement = document.createElement('div')
      replacement.style.cssText = 'width:100px;height:50px;rotate:30deg;'
      document.body.append(element, replacement)
      cleanups.push(() => {
        element.remove()
        replacement.remove()
      })

      const call = link({ input: 0 })
      const controller = propertyController(call.value)
      let reboundCleanup: (() => void) | undefined
      controller.configure({
        target: 'self',
        property: 'rotate',
        motion: new PropertyMotion(),
        report: () => {
          if (action === 'dispose') call.dispose()
          else {
            reboundCleanup = call.bind(new Map([['self', replacement]]), () => {})
            cleanups.push(reboundCleanup)
          }
        },
      })

      const cleanup = call.bind(new Map([['self', element]]), () => {})
      cleanups.push(cleanup)

      expect(call.readSnapshot?.({ time: performance.now() })).toMatchObject({
        attached: action === 'rebind',
        value: action === 'dispose' ? 0 : 30,
      })

      cleanup()

      reboundCleanup?.()
    },
  )

  it('releases a failed initial binding and propagates its diagnostic error', () => {
    const element = document.createElement('div')
    element.style.cssText = 'width:100px;height:50px;rotate:x 20deg;'
    document.body.append(element)
    cleanups.push(() => element.remove())
    const failure = new Error('Diagnostic failed')
    const call = link({ input: 0 })
    const controller = propertyController(call.value)
    controller.configure({
      target: 'self',
      property: 'rotate',
      motion: new PropertyMotion(),
      report: () => {
        throw failure
      },
    })

    expect(() => call.bind(new Map([['self', element]]), () => {})).toThrow(failure)

    element.style.rotate = '30deg'

    expect(call.readSnapshot?.({ time: performance.now() })).toMatchObject({
      attached: false,
      value: 0,
    })

    call.dispose()
  })

  it('keeps an unbound controller inactive when acquisition is requested', () => {
    const call = link({ input: 10 })
    const controller = propertyController(call.value)

    controller.acquire(performance.now())

    expect(controller.control()).toBeUndefined()
    expect(call.value).toMatchObject({ value: 10, attached: false })

    call.dispose()
  })
})
