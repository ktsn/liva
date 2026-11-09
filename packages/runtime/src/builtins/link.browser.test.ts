import { afterEach, describe, expect, it } from 'vite-plus/test'
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
    warnings,
    update,
    time,
    get notifications() {
      return notifications
    },
  }
}

async function frames() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

describe('link property adapters', () => {
  it.each(['width', 'rotate'])('renders frozen scalar %s observations for previews', (property) => {
    const binding = setup(property)

    binding.controller.setPreview(true)
    binding.controller.setPreview(true)

    expect(binding.controller.render(property, binding.call.value)).toBe(
      property === 'rotate' ? '30deg' : '100px',
    )
    binding.controller.setPreview(false)
  })

  it('reads mapped fallback while bound to a missing receiving target', async () => {
    const call = link({ input: 10, component: 'x' })
    const controller = propertyController(call.value)
    cleanups.push(call.bind(new Map(), () => {}))
    controller.setPreview(true)
    controller.setPreview(false)

    await frames()

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

  it('uses mapped fallback values and velocity after target absence, then rebases recovery', async () => {
    const binding = setup('translate', 0, { component: 'y', sensitivity: -2 })
    binding.element.style.display = 'none'

    await frames()

    expect(binding.call.value).toMatchObject({
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

    await frames()

    binding.controller.acquire(performance.now())
    expect(binding.call.value).toMatchObject({
      value: { x: 100, y: 50, z: 7 },
      velocity: { x: 0, y: 0, z: 0 },
      attached: true,
    })
    expect(binding.controller.control()?.value).toBe('100px 50px 7px')
    expect(binding.warnings).toEqual([])
  })

  it('diagnoses unreadable values once, preserves normal styles, and recovers', async () => {
    const binding = setup('rotate')
    binding.element.style.rotate = 'x 20deg'

    await frames()
    await frames()

    expect(binding.call.value).toMatchObject({ value: 0, attached: false })
    expect(binding.controller.control()).toBeUndefined()
    expect(binding.warnings).toHaveLength(1)

    binding.element.style.rotate = '40deg'

    await frames()

    expect(binding.call.value).toMatchObject({ value: 40, velocity: 0, attached: true })
  })

  it('freezes observations during manual preview and resumes afterwards', async () => {
    const binding = setup('translate', 0, { component: 'x' })
    binding.controller.setPreview(true)
    binding.element.style.translate = '200px 50px 7px'

    await frames()

    expect(binding.call.readSnapshot?.({ time: performance.now() })).toMatchObject({
      value: { x: 100, y: 50, z: 7 },
    })
    expect(binding.controller.render('translate', binding.call.value)).toBe('100px 50px 7px')

    binding.controller.setPreview(false)

    await frames()

    expect(binding.call.value).toMatchObject({ value: { x: 200, y: 50, z: 7 } })
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

  it('keeps an unbound controller inactive when acquisition is requested', () => {
    const call = link({ input: 10 })
    const controller = propertyController(call.value)

    controller.acquire(performance.now())

    expect(controller.control()).toBeUndefined()
    expect(call.value).toMatchObject({ value: 10, attached: false })

    call.dispose()
  })
})
