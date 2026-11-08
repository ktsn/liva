import { callBuiltin } from './builtins/index.ts'
import {
  isReactiveSubscription,
  isReactiveCall,
  type PreparedUpdate,
  type ReactiveCall,
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

/** Call-site identities must remain stable within each binding across evaluations. */
interface ReactiveCallEvaluation {
  invoke(binding: string, id: number, name: string, args: FunctionArguments): RuntimeValue
}

/**
 * Owns cached calls and their subscriptions for one let graph. Compatible bindings
 * may borrow a previous store's calls during construction; dispose(replacement)
 * transfers ownership when the replacement is accepted.
 */
export class ReactiveCallStore {
  private calls: CallSites = new Map()
  private initializing = true
  private evaluating = false
  private disposed = false
  private notificationPending = false
  private notificationQueued = false

  private notify = () => {
    if (!this.binding) return

    if (!this.evaluating) {
      this.binding.update()
      return
    }

    this.notificationPending = true
  }

  private flushNotifications() {
    if (!this.notificationPending) return

    this.notificationPending = false
    if (this.notificationQueued) return
    this.notificationQueued = true

    queueMicrotask(() => {
      this.notificationQueued = false
      this.notify()
    })
  }

  private binding?: {
    targets: ReadonlyMap<string, HTMLElement>
    update: () => void
    cleanups: Map<ReactiveSubscription, () => void>
  }

  /** Only binding names with structurally identical initializers may be retained. */
  constructor(previous?: ReactiveCallStore, retainedBindings: readonly string[] = []) {
    for (const name of retainedBindings) {
      this.calls.set(name, new Map(previous?.calls.get(name)))
    }
  }

  /**
   * Reads candidate snapshots, then commits only if evaluation and validation succeed.
   * The callback must finish synchronously. Failures discard prepared updates and
   * dispose new calls, preserving committed calls. Evaluation after disposal or
   * recursive evaluation throws. Commit-time notifications wait until completion.
   */
  evaluate<T>(read: (evaluation: ReactiveCallEvaluation) => T): T {
    if (this.disposed) throw new Error('Cannot evaluate a disposed let graph')
    if (this.evaluating) throw new Error('Cannot reenter a let evaluation')

    this.evaluating = true
    const evaluation = new PreparedCalls(this.calls, this.initializing)
    let committed = false

    try {
      const value = read(evaluation)
      const active = callResults(evaluation.calls)
      this.updateSubscriptions(active)
      evaluation.commitUpdates()

      const removed = callResults(this.calls)
      this.calls = evaluation.calls
      committed = true

      // Initial caches belong to a live graph until its caller accepts the candidate.
      // Never update or dispose these borrowed instances during initial evaluation.
      if (!this.initializing) disposeCalls(removed, active)
      this.initializing = false

      return value
    } finally {
      if (!committed) {
        evaluation.discard()
        this.notificationPending = false
      }

      this.evaluating = false
      this.flushNotifications()
    }
  }

  /** Release owned calls, preserving instances transferred to a replacement store. */
  dispose(retained?: ReactiveCallStore) {
    if (this.disposed) return

    this.disposed = true

    for (const cleanup of this.binding?.cleanups.values() ?? []) cleanup()
    this.binding = undefined

    disposeCalls(callResults(this.calls), retained ? callResults(retained.calls) : new Set())
  }

  private updateSubscriptions(results: ReadonlySet<FunctionResult>) {
    const binding = this.binding
    if (!binding) return

    const active = new Set([...results].filter(isReactiveSubscription))
    const added = new Map<ReactiveSubscription, () => void>()

    try {
      for (const subscription of active) {
        if (!binding.cleanups.has(subscription)) {
          let subscribed = true
          const cleanup = subscription.bind(binding.targets, () => {
            if (subscribed && this.binding === binding) this.notify()
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

    for (const [subscription, cleanup] of binding.cleanups) {
      if (!active.has(subscription)) {
        cleanup()
        binding.cleanups.delete(subscription)
      }
    }

    for (const [subscription, cleanup] of added) binding.cleanups.set(subscription, cleanup)
  }

  bind(targets: ReadonlyMap<string, HTMLElement>, update: () => void): (() => void)[] {
    const binding = { targets, update, cleanups: new Map<ReactiveSubscription, () => void>() }
    this.binding = binding
    this.evaluating = true

    try {
      this.updateSubscriptions(callResults(this.calls))
    } finally {
      this.evaluating = false
      this.flushNotifications()
    }

    return [
      () => {
        for (const cleanup of binding.cleanups.values()) cleanup()
        binding.cleanups.clear()
        if (this.binding === binding) this.binding = undefined
      },
    ]
  }
}

/** Candidate call state stays separate from the store until the entire read succeeds. */
class PreparedCalls implements ReactiveCallEvaluation {
  readonly calls: CallSites = new Map()
  private readonly prepared: PreparedUpdate[] = []
  private readonly created = new Set<ReactiveCall>()
  private readonly snapshots = new Map<FunctionResult, RuntimeValue>()
  private readonly previous: CallSites
  private readonly initializing: boolean

  constructor(previous: CallSites, initializing: boolean) {
    this.previous = previous
    this.initializing = initializing
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
      const update = retained.result.prepareUpdate(args)
      this.prepared.push(update)
      this.snapshots.set(retained.result, update.value)
      site = { name, args, result: retained.result }
    } else {
      const result = callBuiltin(name, args)

      if (isReactiveCall(result)) this.created.add(result)

      site = { name, args, result }
    }

    let calls = this.calls.get(binding)

    if (!calls) {
      calls = new Map()
      this.calls.set(binding, calls)
    }

    calls.set(id, site)

    if (!isReactiveSubscription(site.result)) return site.result
    if (!this.snapshots.has(site.result)) this.snapshots.set(site.result, site.result.value)

    return this.snapshots.get(site.result)!
  }

  commitUpdates() {
    for (const update of this.prepared) update.commit()
  }

  discard() {
    for (const update of this.prepared) update.discard()
    for (const result of this.created) result.dispose()
  }
}

function callResults(calls: CallSites): Set<FunctionResult> {
  return new Set(
    [...calls.values()].flatMap((sites) => [...sites.values()].map((site) => site.result)),
  )
}

function disposeCalls(results: ReadonlySet<FunctionResult>, retained: ReadonlySet<FunctionResult>) {
  for (const result of results) {
    if (!retained.has(result) && isReactiveCall(result)) result.dispose()
  }
}
