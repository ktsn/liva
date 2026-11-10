import type { ReactiveSubscription, RuntimeValue } from './reactive-value.ts'

/**
 * Observations captured for one notification at a shared millisecond timestamp.
 * Subscription identity keys the readable snapshots so consumers can evaluate a
 * consistent event-time view instead of rereading independently changing sources.
 */
export interface ReactiveNotification {
  readonly time: number
  readonly snapshots: ReadonlyMap<ReactiveSubscription, RuntimeValue>
}
