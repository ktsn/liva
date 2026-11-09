import { describe, expect, it, vi } from 'vite-plus/test'
import { link } from './link.ts'
import { propertyController } from '../controllers.ts'
import type { FunctionArguments } from '../reactive-value.ts'

describe('unbound link inputs', () => {
  it.each<FunctionArguments>([
    { input: true },
    { input: { x: 1 } },
    { input: { x: 1, y: 2, z: 3 } },
    { input: { x: 1, y: 2 }, component: 'x' },
    { input: 1, component: 'z' },
    { input: 1, sensitivity: Infinity },
    { input: NaN },
    { input: Number.MAX_VALUE, sensitivity: 2 },
  ])('rejects invalid arguments without inventing a fallback: %j', (args) => {
    expect(() => link(args)).toThrow(/link/)
  })

  it('measures mapped fallback velocity without attachment or gesture knowledge', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const call = link({ input: 10, sensitivity: -2 })
    const time = performance.now()
    const first = call.prepareUpdate({ input: 10, sensitivity: -2 }, { time })
    first.commit()

    const changed = call.prepareUpdate({ input: 15, sensitivity: -2 }, { time: time + 10 })
    changed.commit()

    expect(changed.value).toMatchObject({ value: -30, velocity: -1, attached: false })
    expect(call.readSnapshot?.({ time: time + 20 })).toMatchObject({ velocity: -1 })
    expect(call.readSnapshot?.({ time: time + 100 })).toMatchObject({ velocity: 0 })
    expect(propertyController(call.value).control()).toBeUndefined()

    clock.mockRestore()
  })

  it('keeps vector call sites independent and clears histories on configuration changes', () => {
    const first = link({ input: { x: 1, y: 2 } })
    const second = link({ input: { x: 1, y: 2 } })
    const time = performance.now()
    const update = first.prepareUpdate({ input: { x: 3, y: 4 }, sensitivity: -1 }, { time })
    update.commit()

    expect(first.value).toMatchObject({
      value: { x: -3, y: -4, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    })
    expect(second.value).toMatchObject({ value: { x: 1, y: 2, z: 0 } })
    expect(propertyController(first.value)).not.toBe(propertyController(second.value))
    expect(() => first.prepareUpdate({ input: 1 })).toThrow(/shape/)
  })

  it.each([50, 200])('rejects stale fallback velocity at timestamp %s', (time) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const call = link({ input: 10 })

    const changed = call.prepareUpdate({ input: 15 }, { time })

    expect(changed.value).toMatchObject({ value: 15, velocity: 0, attached: false })
    expect(call.value).toMatchObject({ value: 10 })

    changed.discard()
    clock.mockRestore()
  })
})
