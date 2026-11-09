import type { ReactiveSubscription, RuntimeValue } from './reactive-value.ts'

export interface ReactiveNotification {
  readonly time: number
  readonly snapshots: ReadonlyMap<ReactiveSubscription, RuntimeValue>
}
