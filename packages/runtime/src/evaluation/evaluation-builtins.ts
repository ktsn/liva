import type { FunctionArguments, FunctionResult, RuntimeValue } from './reactive-value.ts'

export interface EvaluationBuiltins {
  readonly constants?: Readonly<Record<string, RuntimeValue>>
  readonly functions?: Readonly<Record<string, (args: FunctionArguments) => RuntimeValue>>
}

export type ReactiveBuiltins = Readonly<Record<string, (args: FunctionArguments) => FunctionResult>>
