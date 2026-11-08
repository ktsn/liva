import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { timeout } from './timeout.ts'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

describe('timeout', () => {
  it('starts an initially active timer only at binding activation', () => {
    const timer = timeout({ when: true, duration: 100 })
    const publish = vi.fn<(value: import('../reactive-value.ts').RuntimeValue) => void>()

    vi.advanceTimersByTime(200)
    expect(timer.value).toBe(false)

    timer.bind(new Map(), publish)
    vi.advanceTimersByTime(99)
    expect(timer.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(timer.value).toBe(true)
    expect(publish).toHaveBeenCalledExactlyOnceWith(true)

    timer.dispose()
  })

  it('does not restart unchanged arguments and resets on false', () => {
    const timer = timeout({ when: false, duration: 100 })
    const publish = vi.fn<(value: import('../reactive-value.ts').RuntimeValue) => void>()
    timer.bind(new Map(), publish)

    timer.prepareUpdate({ when: true, duration: 100 }).commit()
    vi.advanceTimersByTime(50)
    timer.prepareUpdate({ when: true, duration: 100 }).commit()
    vi.advanceTimersByTime(50)

    expect(timer.value).toBe(true)

    timer.prepareUpdate({ when: false, duration: 100 }).commit()

    expect(timer.value).toBe(false)

    timer.prepareUpdate({ when: true, duration: 100 }).commit()
    vi.advanceTimersByTime(50)
    timer.prepareUpdate({ when: false, duration: 100 }).commit()
    vi.advanceTimersByTime(100)

    expect(timer.value).toBe(false)
    expect(publish).toHaveBeenCalledTimes(1)

    timer.dispose()
  })

  it('restarts an active timer on duration changes but discards uncommitted changes', () => {
    const timer = timeout({ when: true, duration: 100 })
    timer.bind(new Map(), () => {})

    vi.advanceTimersByTime(80)
    timer.prepareUpdate({ when: true, duration: 200 }).discard()
    vi.advanceTimersByTime(20)

    expect(timer.value).toBe(true)

    timer.prepareUpdate({ when: true, duration: 50 }).commit()
    vi.advanceTimersByTime(49)
    expect(timer.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(timer.value).toBe(true)

    timer.dispose()
  })

  it('schedules zero duration and cancels obsolete callbacks on unbind and disposal', () => {
    const timer = timeout({ when: true, duration: 0 })
    const publish = vi.fn<(value: import('../reactive-value.ts').RuntimeValue) => void>()
    const unbind = timer.bind(new Map(), publish)

    expect(timer.value).toBe(false)

    unbind()
    vi.runAllTimers()
    expect(publish).not.toHaveBeenCalled()

    timer.bind(new Map(), publish)
    vi.runAllTimers()
    expect(timer.value).toBe(true)

    timer.prepareUpdate({ when: false, duration: 0 }).commit()
    timer.prepareUpdate({ when: true, duration: 0 }).commit()
    timer.dispose()
    vi.runAllTimers()

    expect(publish).toHaveBeenCalledTimes(1)
  })

  it.each([-1, Infinity, NaN])(
    'rejects duration %s without changing the active timer',
    (duration) => {
      const timer = timeout({ when: true, duration: 100 })
      timer.bind(new Map(), () => {})

      expect(() => timer.prepareUpdate({ when: true, duration })).toThrow('finite')

      vi.advanceTimersByTime(100)
      expect(timer.value).toBe(true)

      timer.dispose()
    },
  )
  it('rejects invalid condition and duration argument types', () => {
    expect(() => timeout({ when: 1, duration: 100 })).toThrow('boolean')
    expect(() => timeout({ when: true, duration: '100' })).toThrow('finite')
  })

  it('suppresses a stale callback even if the host already queued it', () => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const timer = timeout({ when: true, duration: 100 })
    const publish = vi.fn<(value: import('../reactive-value.ts').RuntimeValue) => void>()
    timer.bind(new Map(), publish)
    const callback = scheduled.mock.calls[0]?.[0]

    timer.prepareUpdate({ when: false, duration: 100 }).commit()

    if (typeof callback !== 'function') throw new Error('Expected scheduled callback')
    callback()

    expect(timer.value).toBe(false)
    expect(publish).not.toHaveBeenCalled()

    timer.dispose()
    scheduled.mockRestore()
  })
  it('waits across the native signed 32-bit timer limit', () => {
    const duration = 2_147_483_648
    const timer = timeout({ when: true, duration })
    const publish = vi.fn<(value: import('../reactive-value.ts').RuntimeValue) => void>()
    timer.bind(new Map(), publish)

    vi.advanceTimersByTime(2_147_483_647)

    expect(timer.value).toBe(false)
    expect(publish).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)

    expect(timer.value).toBe(true)
    expect(publish).toHaveBeenCalledExactlyOnceWith(true)

    timer.dispose()
  })
})
