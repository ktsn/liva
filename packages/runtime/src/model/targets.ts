import type { Declaration, Definition, Target } from './definition.ts'

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

/** Every potential authored receiver, including targets with only layout declarations. */
export function declarationTargets(definition: Definition): readonly Target<Declaration>[] {
  return definition.layers.flatMap((layer) => [
    ...layer.targets,
    ...(layer.states ?? []).flatMap((state) => state.targets),
  ])
}

/** Target-valued names in Motion scope, including names declared in inactive states. */
export function definitionTargetNames(definition: Definition): ReadonlySet<string> {
  return new Set([ROOT_TARGET, ...declarationTargets(definition).map((target) => target.name)])
}
