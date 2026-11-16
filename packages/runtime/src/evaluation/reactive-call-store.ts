import { releaseResources } from './resource-cleanup.ts'
import type { ReactiveNotification } from './events.ts'
import { callBuiltin } from '../builtins/index.ts'
import {
  isReactiveSubscription,
  isReactiveCall,
  type PreparedUpdate,
  type ReactiveCall,
  type SourceConnection,
  type FunctionArguments,
  type FunctionResult,
  type ReactiveSubscription,
  type RuntimeValue,
} from './reactive-value.ts'

type CallSite = {
  readonly name: string
  readonly args: FunctionArguments
  readonly result: FunctionResult
}

type CallSites = Map<string, Map<number, CallSite>>

/** One subscription session; identity separates queued occurrences from later bindings. */
type SubscriptionBinding = {
  connect: SourceConnection
  update: (notification?: ReactiveNotification) => void
  cleanups: Map<ReactiveSubscription, () => void>
}

/**
 * Reads call results within one synchronous evaluation. Binding names and call-site
 * indices must identify the same expression across evaluations. Do not retain this
 * reader beyond the evaluation callback.
 */
export interface ReactiveCallEvaluation {
  invoke(binding: string, id: number, name: string, args: FunctionArguments): RuntimeValue
}

/**
 * Manages built-in call results, subscriptions, and resource ownership for one let
 * graph. The caller owns expression evaluation and validation; this store accepts
 * call state only after that synchronous work succeeds.
 *
 * ReactiveCall preparation must be pure and commit must not throw. These contracts
 * preserve committed state on evaluation failures; arbitrary committed side effects
 * cannot be rolled back. Unbound stores read values without activating subscriptions.
 * Borrowed calls must be preserved with dispose(retained) when accepting or rejecting
 * a replacement store.
 */
export class ReactiveCallStore {
  private calls: CallSites = new Map()
  private initializing = true
  private evaluating = false
  private disposed = false
  private notificationPending = false
  private notificationQueued = false
  private eventNotificationQueued = false
  private readonly eventNotifications: {
    binding: SubscriptionBinding
    notification: ReactiveNotification
  }[] = []

  private notify = (notification?: ReactiveNotification) => {
    if (!this.binding) return

    if (!this.evaluating && !this.eventNotificationQueued) {
      this.binding.update(notification)
      return
    }

    // Binding and commit may publish synchronously. Reentry here would expose only
    // part of the candidate state, so wait until the store leaves the current phase.
    if (notification?.event) this.eventNotifications.push({ binding: this.binding, notification })
    else this.notificationPending = true
  }

  private flushNotifications() {
    // Event pulses carry distinct snapshots and must retain their order rather than
    // coalescing like ordinary state changes. A replaced binding cannot receive them.
    if (this.eventNotifications.length > 0 && !this.eventNotificationQueued) {
      const pending = this.eventNotifications.splice(0)
      this.eventNotificationQueued = true

      queueMicrotask(() => {
        try {
          // Keep the queue owned through delivery. Synchronous publications made
          // after scheduling or during a callback must follow this entire batch.
          for (const { binding, notification } of pending) {
            if (this.binding === binding) binding.update(notification)
          }
        } finally {
          this.eventNotificationQueued = false
          this.flushNotifications()
        }
      })
    }

    if (!this.notificationPending) return

    this.notificationPending = false
    if (this.notificationQueued) return
    this.notificationQueued = true

    // Several updates can finish before this task runs; one notification reads their
    // latest committed state. Delivery checks that a binding still exists.
    queueMicrotask(() => {
      this.notificationQueued = false
      this.notify()
    })
  }

  private binding?: SubscriptionBinding

  /**
   * Borrows caches for retainedBindings from previous. The caller must establish
   * that these names have structurally identical initializers. Borrowing does not
   * transfer ownership or activate subscriptions.
   */
  constructor(previous?: ReactiveCallStore, retainedBindings: readonly string[] = []) {
    for (const name of retainedBindings) {
      this.calls.set(name, new Map(previous?.calls.get(name)))
    }
  }

  /**
   * Runs read synchronously and returns its result after accepting candidate calls.
   * read must complete all validation before returning and must not retain its reader.
   * Evaluation or subscription-binding failures propagate, preserving committed calls
   * and releasing candidate resources. Disposed or recursive evaluation throws.
   * Notifications emitted during evaluation are deferred until it finishes.
   */
  evaluate<T>(
    read: (evaluation: ReactiveCallEvaluation) => T,
    notification?: ReactiveNotification,
  ): T {
    if (this.disposed) throw new Error('Cannot evaluate a disposed let graph')
    if (this.evaluating) throw new Error('Cannot reenter a let evaluation')

    // Isolate candidate caches and snapshots while the callback evaluates and validates
    // the whole graph. Notifications cannot reenter until this transaction finishes.
    this.evaluating = true
    const pendingEvents = this.eventNotifications.length
    const pendingNotification = this.notificationPending
    const evaluation = new PreparedCalls(this.calls, this.initializing, notification)
    let committed = false

    try {
      const value = read(evaluation)
      const active = callResults(evaluation.calls)

      // Bind additions before committing updates: binding can fail, whereas prepared
      // commits must be infallible. Failed additions leave existing bindings intact.
      this.updateSubscriptions(active)
      evaluation.commitUpdates()

      // Publish cache ownership only after all updates commit. Mark acceptance before
      // retiring obsolete calls so finalization cannot discard already accepted state.
      const removed = callResults(this.calls)
      this.calls = evaluation.calls
      committed = true

      // Initial caches belong to a live graph until its caller accepts the candidate.
      // Never update or dispose these borrowed instances during initial evaluation.
      if (!this.initializing) disposeCalls(removed, active)
      this.initializing = false

      return value
    } catch (error) {
      if (!committed) {
        // A broken disposer must not hide the validation failure or leave the store
        // evaluating forever. Failed-attempt publications are suppressed in either case.
        try {
          evaluation.discard()
        } catch (cleanupError) {
          // eslint-disable-next-line preserve-caught-error -- Both failures are retained; cause identifies the rejected evaluation.
          throw new AggregateError(
            [error, cleanupError],
            'Could not discard failed call evaluation',
            { cause: error },
          )
        } finally {
          this.notificationPending = pendingNotification
          this.eventNotifications.length = pendingEvents
        }
      }

      throw error
    } finally {
      this.evaluating = false
      this.flushNotifications()
    }
  }

  /**
   * Releases subscriptions and calls once, except calls also held by retained.
   * Retain the replacement on acceptance, or the live store on candidate rejection.
   * Further evaluation throws; queued notifications no longer reach the binding.
   */
  dispose(retained?: ReactiveCallStore) {
    if (this.disposed) return

    this.disposed = true

    // Invalidate identity before cleanup: queued or disposer-time publications
    // cannot reach a binding whose owner has already begun teardown.
    const binding = this.binding
    this.binding = undefined
    const cleanups = [...(binding?.cleanups.values() ?? [])]
    binding?.cleanups.clear()
    const owned = callResults(this.calls)
    this.calls.clear()

    releaseResources([
      ...cleanups,
      ...callDisposals(owned, retained ? callResults(retained.calls) : new Set()),
    ])
  }

  private updateSubscriptions(results: ReadonlySet<FunctionResult>) {
    const binding = this.binding
    if (!binding) return

    const active = new Set([...results].filter(isReactiveSubscription))
    const added = new Map<ReactiveSubscription, () => void>()

    // Stage additions without removing committed subscriptions: if a later bind
    // throws, only additions from this attempt need cleanup.
    try {
      for (const subscription of active) {
        if (!binding.cleanups.has(subscription)) {
          let subscribed = true
          const cleanup = binding.connect(subscription, (value, notification) => {
            // Ignore callbacks retained by a removed subscription or an older binding.
            if (!subscribed || this.binding !== binding) return

            const snapshots = new Map<ReactiveSubscription, RuntimeValue>(notification?.snapshots)
            const time = notification?.time ?? performance.now()

            // Capture all committed calls at one time before notifying the graph, so
            // event handling and dependent controllers consume the same input sample.
            for (const result of callResults(this.calls)) {
              if (isReactiveSubscription(result) && !snapshots.has(result))
                snapshots.set(
                  result,
                  isReactiveCall(result) && result.readSnapshot
                    ? result.readSnapshot({ time })
                    : result.value,
                )
            }

            snapshots.set(subscription, value)
            this.notify({
              ...notification,
              time: notification?.time ?? performance.now(),
              snapshots,
            })
          })
          added.set(subscription, () => {
            subscribed = false
            cleanup()
          })
        }
      }
    } catch (error) {
      for (const cleanup of added.values()) cleanup()
      throw error
    }

    // All additions succeeded, so the binding can adopt the candidate subscription set.
    for (const [subscription, cleanup] of binding.cleanups) {
      if (!active.has(subscription)) {
        cleanup()
        binding.cleanups.delete(subscription)
      }
    }

    for (const [subscription, cleanup] of added) binding.cleanups.set(subscription, cleanup)
  }

  /**
   * Activates cached sources through connect and delivers later changes to update.
   * Returns cleanup callbacks that stop this binding while retaining cached call values.
   * Synchronous bind-time notifications are deferred; subscription errors propagate.
   */
  bind(
    connect: SourceConnection,
    update: (notification?: ReactiveNotification) => void,
  ): (() => void)[] {
    const previous = this.binding
    const pendingEvents = this.eventNotifications.length
    const pendingNotification = this.notificationPending
    const binding = { connect, update, cleanups: new Map<ReactiveSubscription, () => void>() }
    this.binding = binding

    // Initial source connection may notify immediately. Use the evaluation guard until every
    // subscription has bound so the consumer cannot observe a partially bound store.
    this.evaluating = true
    let bound = false

    try {
      this.updateSubscriptions(callResults(this.calls))
      bound = true
    } finally {
      if (!bound) {
        // Added subscriptions were cleaned by updateSubscriptions. Discard their
        // publications too, without erasing occurrences accepted before this bind.
        this.eventNotifications.length = pendingEvents
        this.notificationPending = pendingNotification
        this.binding = previous
      }

      this.evaluating = false
      this.flushNotifications()
    }

    return [
      () => {
        if (this.binding === binding) this.binding = undefined
        const cleanups = [...binding.cleanups.values()]
        binding.cleanups.clear()

        releaseResources(cleanups)
      },
    ]
  }
}

/**
 * Holds tentative call results for one store evaluation. Reads expose candidate
 * snapshots without updating retained calls; the store must either commit prepared
 * updates or discard them and release newly created calls.
 */
class PreparedCalls implements ReactiveCallEvaluation {
  readonly calls: CallSites = new Map()
  private readonly prepared: PreparedUpdate[] = []
  private readonly created = new Set<ReactiveCall>()
  private readonly snapshots: Map<FunctionResult, RuntimeValue>
  private readonly context: { readonly time: number }
  private readonly previous: CallSites
  private readonly initializing: boolean

  constructor(previous: CallSites, initializing: boolean, notification?: ReactiveNotification) {
    this.previous = previous
    this.initializing = initializing
    this.snapshots = new Map(notification?.snapshots)
    this.context = { time: notification?.time ?? performance.now() }
  }

  invoke(binding: string, id: number, name: string, args: FunctionArguments): RuntimeValue {
    const retained = this.previous.get(binding)?.get(id)
    const sameFunction = retained?.name === name
    const matches =
      sameFunction &&
      Object.keys(args).length === Object.keys(retained.args).length &&
      Object.entries(args).every(
        ([argumentName, argument]) => retained.args[argumentName] === argument,
      )
    let site: CallSite

    if (matches) {
      site = retained
    } else if (sameFunction && !this.initializing && isReactiveCall(retained.result)) {
      // Dependent expressions need the updated value before validation, but the live
      // instance must stay unchanged until the entire evaluation is accepted.
      const update = retained.result.prepareUpdate(args, this.context)
      this.prepared.push(update)
      this.snapshots.set(retained.result, update.value)
      site = { name, args, result: retained.result }
    } else {
      // Changed ordinary calls are recomputed. During initial evaluation, changed
      // borrowed calls also need new instances to keep the live store untouched.
      const result = callBuiltin(name, args)

      if (isReactiveCall(result)) this.created.add(result)

      site = { name, args, result }
    }

    // Record only calls reached by this evaluation. Omitting inactive branches lets
    // acceptance retire results that no active call still needs.
    let calls = this.calls.get(binding)

    if (!calls) {
      calls = new Map()
      this.calls.set(binding, calls)
    }

    calls.set(id, site)

    // Repeated reads of a shared result use one snapshot, even if its live getter
    // changes. A prepared snapshot above takes precedence over the committed value.
    if (!isReactiveSubscription(site.result)) return site.result
    if (!this.snapshots.has(site.result))
      this.snapshots.set(
        site.result,
        isReactiveCall(site.result) && site.result.readSnapshot
          ? site.result.readSnapshot(this.context)
          : site.result.value,
      )

    return this.snapshots.get(site.result)!
  }

  commitUpdates() {
    for (const update of this.prepared) update.commit()
  }

  discard() {
    releaseResources([
      ...[...this.prepared].map((update) => () => update.discard()),
      ...[...this.created].map((result) => () => result.dispose()),
    ])
  }
}

function callResults(calls: CallSites): Set<FunctionResult> {
  return new Set(
    [...calls.values()].flatMap((sites) => [...sites.values()].map((site) => site.result)),
  )
}

function callDisposals(
  results: ReadonlySet<FunctionResult>,
  retained: ReadonlySet<FunctionResult>,
): (() => void)[] {
  return [...results]
    .filter((result) => !retained.has(result))
    .filter(isReactiveCall)
    .map((result) => () => result.dispose())
}

function disposeCalls(results: ReadonlySet<FunctionResult>, retained: ReadonlySet<FunctionResult>) {
  releaseResources(callDisposals(results, retained))
}
