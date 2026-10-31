import { drag } from './drag.ts'
import type { FunctionResult, RuntimeValue } from '../reactive-value.ts'

export type { FunctionResult, RuntimeValue } from '../reactive-value.ts'

const functions: ReadonlyMap<
  string,
  (args: Readonly<Record<string, RuntimeValue>>) => FunctionResult
> = new Map([['drag', drag]])

export function callBuiltin(
  name: string,
  args: Readonly<Record<string, RuntimeValue>>,
): FunctionResult {
  const implementation = functions.get(name)

  if (!implementation) throw new Error(`Unknown function: ${name}`)

  return implementation(args)
}
