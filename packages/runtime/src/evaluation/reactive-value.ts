import type { ReactiveNotification } from './events.ts'

export type Scalar = number | boolean | string
export type RuntimeValue = Scalar | { readonly [name: string]: RuntimeValue }

/** Evaluation-facing source identity. Browser connection capabilities are separate. */
export interface ReactiveSource {
  readonly value: RuntimeValue
}

/**
 * Connects a source identity through the browser owner, preserving the same object
 * used by snapshot maps and controller capabilities. Returns an idempotent cleanup;
 * connection failures throw. Store guards synchronous publications during acceptance,
 * while the browser owner retains the native adapter resources and their cleanup.
 */
export type SourceConnection = (
  source: ReactiveSource,
  publish: (value: RuntimeValue, notification?: ReactiveNotification) => void,
) => () => void

export interface ReactiveSubscription extends ReactiveSource {
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

export interface EvaluatedCall extends ReactiveSource {
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

/** Existing DOM-aware adapter, viewed as EvaluatedCall during evaluation. */
export interface ReactiveCall extends EvaluatedCall, ReactiveSubscription {}

export type FunctionResult = RuntimeValue | ReactiveSource | EvaluatedCall

/** Builtin implementations return the DOM-capable adapter, retained by identity as a source. */
export type BuiltinResult = RuntimeValue | ReactiveSubscription | ReactiveCall

export function isReactiveCall(value: FunctionResult): value is EvaluatedCall {
  return (
    isReactiveSource(value) &&
    'prepareUpdate' in value &&
    typeof value.prepareUpdate === 'function' &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  )
}

export function isReactiveSource(value: FunctionResult): value is ReactiveSource {
  return (
    typeof value === 'object' &&
    'value' in value &&
    'bind' in value &&
    typeof value.bind === 'function'
  )
}

/** Existing adapters share source identity; only browser execution uses this capability view. */
export function isReactiveSubscription(value: FunctionResult): value is ReactiveSubscription {
  return isReactiveSource(value)
}
