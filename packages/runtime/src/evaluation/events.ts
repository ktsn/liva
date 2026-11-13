import type { ReactiveSubscription, RuntimeValue } from './reactive-value.ts'

const events = new WeakSet<object>()

/**
 * Observations captured for one notification at a shared millisecond timestamp.
 * Subscription identity keys the readable snapshots so consumers can evaluate a
 * consistent event-time view instead of rereading independently changing sources.
 */
export interface ReactiveNotification {
  readonly time: number
  readonly snapshots: ReadonlyMap<ReactiveSubscription, RuntimeValue>
  readonly event?: RuntimeValue
}

export function createEventValue(): RuntimeValue {
  const value = Object.freeze({})
  events.add(value)

  return value
}

export function isEventValue(value: RuntimeValue): boolean {
  return typeof value === 'object' && events.has(value)
}
