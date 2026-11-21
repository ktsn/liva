import { measure } from './measure.ts'
import { timeout } from './timeout.ts'
import { link } from './link.ts'
import { drag } from './drag.ts'
import { interaction } from './interaction.ts'
import type { FunctionResult, RuntimeValue } from '../evaluation/reactive-value.ts'

export type { FunctionResult, RuntimeValue } from '../evaluation/reactive-value.ts'

export const allReactiveBuiltins: import('../evaluation/evaluation-builtins.ts').ReactiveBuiltins =
  {
    measure,
    timeout,
    drag,
    link,
    interaction,
  }

export function callBuiltin(
  name: string,
  args: Readonly<Record<string, RuntimeValue>>,
): FunctionResult {
  const implementation = Object.hasOwn(allReactiveBuiltins, name)
    ? allReactiveBuiltins[name]
    : undefined

  if (!implementation) throw new Error(`Unknown function: ${name}`)

  return implementation(args)
}
