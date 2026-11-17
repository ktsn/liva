import { releaseResources } from '../evaluation/resource-cleanup.ts'

type Completion = (element: HTMLElement, completed?: () => void) => void
let current: Completion | undefined

/**
 * Groups synchronous projection writes across Executors. Native CSS transitions
 * are materialized only after every write, then canceled after every effect read.
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

  const phase = new Map<HTMLElement, Set<() => void>>()
  const finish: Completion = (element, completed) => {
    let callbacks = phase.get(element)

    if (!callbacks) {
      callbacks = new Set()
      phase.set(element, callbacks)
    }

    if (completed) callbacks.add(completed)
  }
  current = finish
  releaseResources([
    () => write(finish),
    () => {
      current = undefined
      const cleanups: (() => void)[] = []
      releaseResources([
        ...[...phase].map(([element, completed]) => () => {
          // All restored inline/native output is already in place. A first style
          // resolution can materialize the whole batch without intervening writes.
          getComputedStyle(element).getPropertyValue('transform')
          const transitions = element
            .getAnimations()
            .filter(
              (animation) =>
                'transitionProperty' in animation && animation.transitionProperty === 'transform',
            )
          cleanups.push(() => {
            releaseResources(transitions.map((animation) => () => animation.cancel()))
            for (const complete of completed) complete()
          })
        }),
        () => releaseResources(cleanups),
      ])
    },
  ])
}
