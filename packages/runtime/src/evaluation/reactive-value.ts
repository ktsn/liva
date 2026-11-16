import type { ReactiveNotification } from './events.ts'

export type Scalar = number | boolean | string
export type RuntimeValue = Scalar | { readonly [name: string]: RuntimeValue }

/**
 * Connects a source identity through the browser owner, preserving the same object
 * used by snapshot maps and controller capabilities. Returns an idempotent cleanup;
 * connection failures throw. Until cleanup is returned, the connector owns any
 * native resources and must unwind them on failure. Store invalidates callbacks
 * from rejected connections and guards synchronous publications during acceptance;
 * the browser owner retains the native adapter resources and their cleanup.
 */
export type SourceConnection = (
  source: ReactiveSubscription,
  publish: (value: RuntimeValue, notification?: ReactiveNotification) => void,
) => () => void

export interface ReactiveSubscription {
  readonly value: RuntimeValue
  bind(
    targets: ReadonlyMap<string, HTMLElement>,
    update: (value: RuntimeValue, notification?: ReactiveNotification) => void,
  ): () => void
}

export type FunctionArguments = Readonly<Record<string, RuntimeValue>>

/** Preparation is pure. Commit must not throw; notifications are delivered after the transaction. */
export interface PreparedUpdate {
  readonly value: RuntimeValue
  commit(): void
  discard(): void
}

export interface ReactiveCall extends ReactiveSubscription {
  /**
   * Optionally reads a coherent observation at a performance.now()-compatible
   * millisecond timestamp without committing argument changes. Implementations may
   * return their frozen published snapshot during manual preview.
   */
  readSnapshot?(context: { readonly time: number }): RuntimeValue

  /**
   * Prepares a candidate value without changing committed call state. Optional time
   * uses the observation's millisecond clock; implementations choose a current time
   * when omitted. Validation failures throw before commit; see PreparedUpdate.
   */
  prepareUpdate(args: FunctionArguments, context?: { readonly time: number }): PreparedUpdate

  /** Releases resources owned by this call; binding cleanup is also managed by its consumer. */
  dispose(): void
}

export type FunctionResult = RuntimeValue | ReactiveSubscription | ReactiveCall

export function isReactiveCall(value: FunctionResult): value is ReactiveCall {
  return (
    isReactiveSubscription(value) &&
    'prepareUpdate' in value &&
    typeof value.prepareUpdate === 'function' &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  )
}

export function isReactiveSubscription(value: FunctionResult): value is ReactiveSubscription {
  return (
    typeof value === 'object' &&
    'value' in value &&
    'bind' in value &&
    typeof value.bind === 'function'
  )
}
