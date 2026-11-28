import type { Property, Target } from '../model/definition.ts'
import type { LetBindingNode } from './let-bindings.ts'

/** Derives stable receiving-address keys for calls and their whole-value aliases. */
export function controllerAddresses(
  nodes: readonly LetBindingNode[],
  targets: readonly Target<Property>[],
): ReadonlyMap<string, string> {
  const addresses = new Map<string, Set<string>>()

  const add = (name: string, address: string) => {
    let entries = addresses.get(name)

    if (!entries) {
      entries = new Set()
      addresses.set(name, entries)
    }

    entries.add(address)
  }

  // Include inactive states too: an attachment belongs to the call's lifetime,
  // not just to the currently effective style. Duplicate declarations share a key.
  for (const target of targets) {
    for (const property of target.properties) {
      if (property.value.kind !== 'binding') continue

      const expression = property.value.expression

      if (expression.kind === 'reference' && expression.path.length === 1)
        add(expression.path[0], JSON.stringify([target.name, property.name]))
    }
  }

  // Consumers precede dependencies in reverse topological order. Propagating here
  // resolves forward aliases without evaluating calls or duplicating cycle checks.
  for (const { definition } of nodes.toReversed()) {
    const expression = definition.initializer

    if (expression.kind === 'reference' && expression.path.length === 1) {
      for (const address of addresses.get(definition.name) ?? []) add(expression.path[0], address)
    }
  }

  return new Map(
    [...addresses].map(([name, entries]) => [name, JSON.stringify([...entries].toSorted())]),
  )
}
