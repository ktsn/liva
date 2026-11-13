import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { link } from './link.ts'
import { propertyController } from '../motion/controllers.ts'
import type { FunctionArguments } from '../evaluation/reactive-value.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it.each([
    { component: 'x', other: 'y', expected: { x: 20, y: 0, z: 0 } },
    { component: 'y', other: 'x', expected: { x: 0, y: 20, z: 0 } },
  ])('preserves the $component mapping after rejecting an axis change', (sample) => {
    const call = link({ input: 10, component: sample.component })
    const previous = call.value

    expect(() => call.prepareUpdate({ input: 20, component: sample.other })).toThrow('fixed')
    expect(call.value).toBe(previous)

    const accepted = call.prepareUpdate({ input: 20, component: sample.component })
    accepted.commit()

    expect(call.value).toMatchObject({ value: sample.expected })

    call.dispose()
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

  it.each([
    { name: 'scalar', initial: 10, moved: 20, rest: 0 },
    {
      name: 'vector',
      initial: { x: 10, y: 20 },
      moved: { x: 20, y: 40 },
      rest: { x: 0, y: 0, z: 0 },
    },
  ])('keeps $name fallback velocity reset when sensitivity preserves the mapped value', (input) => {
    vi.spyOn(performance, 'now').mockReturnValue(100)

    const call = link({ input: input.initial })
    const moved = call.prepareUpdate({ input: input.moved }, { time: 110 })
    moved.commit()

    const rebased = call.prepareUpdate({ input: input.initial, sensitivity: 2 }, { time: 120 })
    rebased.commit()

    expect(rebased.value).toMatchObject({ velocity: input.rest })
    expect(call.readSnapshot?.({ time: 130 })).toMatchObject({ velocity: input.rest })
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

  it('keeps vector derivatives and hold expiry equivalent to independent scalar inputs', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100)

    const vector = link({ input: { x: 0, y: 0 } })
    const x = link({ input: 0 })
    const y = link({ input: 0 })
    const cases = [
      { time: 110, x: 10, y: 0, velocity: { x: 1, y: 0, z: 0 } },
      { time: 120, x: 10, y: 10, velocity: { x: 1, y: 0.5, z: 0 } },
      { time: 189, x: 10, y: 20, velocity: { x: 1, y: 10 / 69, z: 0 } },
      { time: 190, x: 10, y: 30, velocity: { x: 0, y: 10, z: 0 } },
      { time: 200, x: 20, y: 30, velocity: { x: 1, y: 10, z: 0 } },
    ]

    for (const sample of cases) {
      const updates = [
        vector.prepareUpdate({ input: { x: sample.x, y: sample.y } }, sample),
        x.prepareUpdate({ input: sample.x }, sample),
        y.prepareUpdate({ input: sample.y }, sample),
      ]

      for (const update of updates) update.commit()

      expect(vector.value).toMatchObject({ velocity: sample.velocity })
      expect(x.value).toMatchObject({ velocity: sample.velocity.x })
      expect(y.value).toMatchObject({ velocity: sample.velocity.y })
      expect(vector.readSnapshot?.(sample)).toMatchObject({ velocity: sample.velocity })
    }
  })

  describe.each([false, true])('stationary fallback with vector=%s', (vector) => {
    function input(value: number) {
      return vector ? { x: value, y: 0 } : value
    }

    function velocity(value: number) {
      return vector ? { x: value, y: 0, z: 0 } : value
    }

    it('measures resumed movement from the committed rest baseline at exact expiry', () => {
      vi.spyOn(performance, 'now').mockReturnValue(100)

      const call = link({ input: input(0) })
      const moved = call.prepareUpdate({ input: input(10) }, { time: 110 })
      moved.commit()
      const held = call.prepareUpdate({ input: input(10) }, { time: 190 })
      held.commit()

      expect(held.value).toMatchObject({ velocity: velocity(0) })

      const resumed = call.prepareUpdate({ input: input(20) }, { time: 200 })
      resumed.commit()

      expect(resumed.value).toMatchObject({ velocity: velocity(1) })
      expect(call.readSnapshot?.({ time: 210 })).toMatchObject({ velocity: velocity(1) })
    })

    it('does not refresh the rest baseline when the stationary preparation is discarded', () => {
      vi.spyOn(performance, 'now').mockReturnValue(100)

      const call = link({ input: input(0) })
      const moved = call.prepareUpdate({ input: input(10) }, { time: 110 })
      moved.commit()

      const abandoned = call.prepareUpdate({ input: input(10) }, { time: 190 })
      abandoned.discard()
      const resumed = call.prepareUpdate({ input: input(20) }, { time: 200 })
      resumed.commit()

      expect(resumed.value).toMatchObject({ velocity: velocity(0) })
    })
  })
})
