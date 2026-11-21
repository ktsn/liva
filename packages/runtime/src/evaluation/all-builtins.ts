import * as constants from './constants.ts'
import { tween, spring, steps, cubicBezier } from './timing-builtins.ts'
import type { EvaluationBuiltins } from './evaluation-builtins.ts'

export const allPureBuiltins = {
  constants,
  functions: { tween, spring, steps, cubicBezier },
} satisfies EvaluationBuiltins
