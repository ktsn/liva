import type { Definition, MotionFeatures } from '@liva/runtime/core'
import { fullMotionFeatures } from '@liva/runtime/features/execution/full'
import { allReactiveBuiltins } from '@liva/runtime/features/builtins/index'
import { motionFeatures } from '../features.ts'

function select<T>(values: Readonly<Record<string, T>>, names: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)))
}

/** Resolve the edited IR before the runtime evaluates any let or timing expression. */
export function inspectionFeatures(definition: Definition): MotionFeatures {
  const references = motionFeatures(definition)
  const available = fullMotionFeatures

  return {
    pure: {
      constants: select(available.pure.constants, references.constants),
      functions: select(available.pure.functions, references.timings),
    },
    reactive: references.reactive.size
      ? {
          Store: available.reactive.Store,
          builtins: select(allReactiveBuiltins, references.reactive),
        }
      : undefined,
    controllers: references.controllers ? available.controllers : undefined,
  }
}
