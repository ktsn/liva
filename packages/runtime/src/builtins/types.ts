export type Scalar = number | boolean | string
export type RuntimeValue = Scalar | { readonly [name: string]: RuntimeValue }

export interface RuntimeSource {
  readonly value: RuntimeValue
  bind(targets: ReadonlyMap<string, HTMLElement>, update: (value: RuntimeValue) => void): () => void
}
