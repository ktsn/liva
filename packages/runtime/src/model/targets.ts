/** Serialized name of the built-in motion root target. */
export const ROOT_TARGET = 'self'

/** Resolve adapter bindings with the motion root reserved against named overrides. */
export function rootTargetBindings<T>(
  root: T,
  named: Iterable<readonly [string, T]>,
): (readonly [string, T])[] {
  // Preserve repeated names: lifecycle targets may bind multiple DOM elements,
  // and the instance validates duplicates when lifecycle support is absent.
  return [[ROOT_TARGET, root], ...[...named].filter(([name]) => name !== ROOT_TARGET)]
}
