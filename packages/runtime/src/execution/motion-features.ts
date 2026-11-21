import type { resolveLayoutConfigurations, resolveSelectedLayout } from '../composition/layout.ts'
import type { resolveControllerPresentation } from './controller-presentation.ts'
import type { EvaluationBuiltins, ReactiveBuiltins } from '../evaluation/evaluation-builtins.ts'
import type { ReactiveCallStore } from '../evaluation/reactive-call-store.ts'
import type { controllerAddresses } from '../evaluation/controller-addresses.ts'
import type { ExecutorFeatures } from './browser-executor.ts'
import type { FunctionArguments, FunctionResult } from '../evaluation/reactive-value.ts'

export type ReactiveDispatcher = (name: string, args: FunctionArguments) => FunctionResult

/** The implementations a compiled Motion may use over its complete definition. */
export interface MotionFeatures {
  readonly pure?: EvaluationBuiltins
  readonly reactive?: {
    readonly Store: typeof ReactiveCallStore
    readonly builtins: ReactiveBuiltins | ReactiveDispatcher
  }
  readonly layout?: {
    readonly selected: typeof resolveSelectedLayout
    readonly persistent: typeof resolveLayoutConfigurations
  }
  readonly controllers?: {
    readonly addresses: typeof controllerAddresses
    readonly resolve: typeof resolveControllerPresentation
  }
  readonly executor?: ExecutorFeatures
}
