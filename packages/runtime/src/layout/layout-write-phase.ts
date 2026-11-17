import { resolvePropertyComponents } from '../motion/property-rules.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'

// CSS spelling to the existing writing-context resolver's semantic components.
const logicalComponents = [
  ['inline-size', 'inlineSize'],
  ['block-size', 'blockSize'],
  ['inline-start', 'inlineStart'],
  ['inline-end', 'inlineEnd'],
  ['block-start', 'blockStart'],
  ['block-end', 'blockEnd'],
] as const

type Completion = (
  element: HTMLElement,
  properties: Iterable<string>,
  completed?: (addresses: ReadonlySet<string>) => void,
) => void
let current: Completion | undefined

/**
 * Groups synchronous projection writes across Executors. Native CSS transitions
 * for owned properties are materialized only after every write, then canceled
 * after every effect read.
 * Nested owners join the current phase; failures still attempt all queued cleanup
 * and preserve the original cause. No work is deferred beyond this call/paint.
 * The callback's finish argument registers an owned target's transform transition
 * cleanup and optional completion. Completion runs only after successful native
 * cancellation; Executor retains failed resources until a later recovery/disposal.
 */
export function batchLayoutWrites(write: (finish: Completion) => void) {
  if (current) {
    write(current)
    return
  }

  const phase = new Map<
    HTMLElement,
    { properties: Set<string>; callbacks: Set<(addresses: ReadonlySet<string>) => void> }
  >()
  const finish: Completion = (element, properties, completed) => {
    let entry = phase.get(element)

    if (!entry) {
      entry = { properties: new Set(), callbacks: new Set() }
      phase.set(element, entry)
    }

    for (const property of properties) entry.properties.add(property)
    if (completed) entry.callbacks.add(completed)
  }
  current = finish
  releaseResources([
    () => write(finish),
    () => {
      current = undefined
      const cleanups: (() => void)[] = []
      releaseResources([
        ...[...phase].map(([element, { properties, callbacks }]) => () => {
          // All restored inline/native output is already in place. A first style
          // resolution can materialize the whole batch without intervening writes.
          const style = getComputedStyle(element)
          style.getPropertyValue('transform')
          // Engines can expose logical size/padding transitions by their physical
          // names. Reuse the ordinary writing-context resolver, without adding
          // geometry reads or a second logical/physical correspondence table.
          const physical = resolvePropertyComponents(
            {
              kind: 'length',
              components: logicalComponents.map(([, component]) => component),
              unit: 'px',
            },
            style,
          )
          const addresses = new Set(properties)
          for (const property of properties)
            addresses.add(
              logicalComponents.reduce(
                (name, [logical], index) => name.replace(logical, physical[index]),
                property,
              ),
            )
          const transitions = element
            .getAnimations()
            .filter(
              (animation) =>
                'transitionProperty' in animation &&
                typeof animation.transitionProperty === 'string' &&
                addresses.has(animation.transitionProperty),
            )
          cleanups.push(() => {
            releaseResources(transitions.map((animation) => () => animation.cancel()))
            for (const complete of callbacks) complete(addresses)
          })
        }),
        () => releaseResources(cleanups),
      ])
    },
  ])
}
