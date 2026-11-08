export type Scalar = number | boolean | string
export type RuntimeValue = Scalar | { readonly [name: string]: RuntimeValue }

export interface ReactiveSubscription {
  readonly value: RuntimeValue
  bind(targets: ReadonlyMap<string, HTMLElement>, update: (value: RuntimeValue) => void): () => void
}

export type FunctionArguments = Readonly<Record<string, RuntimeValue>>

/** Preparation is pure. Commit must not throw; notifications are delivered after the transaction. */
export interface PreparedUpdate {
  readonly value: RuntimeValue
  commit(): void
  discard(): void
}

export interface ReactiveCall extends ReactiveSubscription {
  prepareUpdate(args: FunctionArguments): PreparedUpdate
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
  return typeof value === 'object' && 'value' in value && typeof value.bind === 'function'
}
