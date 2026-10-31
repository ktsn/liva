import type { CallExpression } from '../definition.ts'
import { drag } from './drag.ts'
import { evaluate, type SourceValues } from '../expression.ts'
import type { RuntimeSource, RuntimeValue } from './types.ts'

export type { RuntimeSource, RuntimeValue } from './types.ts'

const functions: ReadonlyMap<
  string,
  (args: Readonly<Record<string, RuntimeValue>>) => RuntimeSource
> = new Map([['drag', drag]])

export function invokeSource(call: CallExpression, values: SourceValues): RuntimeSource {
  const implementation = functions.get(call.function)

  if (!implementation) throw new Error(`Unknown function: ${call.function}`)

  const args = Object.fromEntries(
    call.arguments.map((argument) => [argument.name, evaluate(argument.value, values)]),
  )

  return implementation(args)
}
