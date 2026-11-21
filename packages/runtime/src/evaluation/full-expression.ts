import { allPureBuiltins } from './all-builtins.ts'
import { renderFrame as render, withDefaultBuiltins } from './expression.ts'

/** Gives standalone calculation APIs the standard pure functions. */
export function builtinValues(values: Parameters<typeof withDefaultBuiltins>[0]) {
  return withDefaultBuiltins(values, allPureBuiltins)
}

export function renderFrame(...[frame, values]: Parameters<typeof render>) {
  return render(frame, builtinValues(values))
}
