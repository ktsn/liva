export type Scalar = number | boolean | string
export type RuntimeValue = Scalar | { readonly [name: string]: RuntimeValue }

export interface ReactiveSubscription {
  readonly value: RuntimeValue
  bind(targets: ReadonlyMap<string, HTMLElement>, update: (value: RuntimeValue) => void): () => void
}

export type FunctionResult = RuntimeValue | ReactiveSubscription

export function isReactiveSubscription(value: FunctionResult): value is ReactiveSubscription {
  return typeof value === 'object' && 'value' in value && typeof value.bind === 'function'
}
