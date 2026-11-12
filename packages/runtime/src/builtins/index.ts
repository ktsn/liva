import { measure } from './measure.ts'
import { timeout } from './timeout.ts'
import { link } from './link.ts'
import { drag } from './drag.ts'
import { interaction } from './interaction.ts'
import type { FunctionResult, RuntimeValue } from '../evaluation/reactive-value.ts'

export type { FunctionResult, RuntimeValue } from '../evaluation/reactive-value.ts'

const functions: ReadonlyMap<
  string,
  (args: Readonly<Record<string, RuntimeValue>>) => FunctionResult
> = new Map([
  ['measure', measure],
  ['timeout', timeout],
  ['drag', drag],
  ['link', link],
  ['interaction', interaction],
])

export function callBuiltin(
  name: string,
  args: Readonly<Record<string, RuntimeValue>>,
): FunctionResult {
  const implementation = functions.get(name)

  if (!implementation) throw new Error(`Unknown function: ${name}`)

  return implementation(args)
}
