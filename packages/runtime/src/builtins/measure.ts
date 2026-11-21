import type { ReactiveSubscription, RuntimeValue } from '../evaluation/reactive-value.ts'
import { missingBounds } from '../layout/layout-bounds.ts'
import { registerLayoutRead } from '../layout/layout-scheduler.ts'

function targetName(value: RuntimeValue | undefined): string {
  if (typeof value !== 'object' || typeof value.name !== 'string') {
    throw new Error('measure requires target values')
  }

  return value.name
}

export function measure(args: Readonly<Record<string, RuntimeValue>>): ReactiveSubscription {
  const target = targetName(args.target)
  const relativeTo = args.relativeTo === undefined ? 'self' : targetName(args.relativeTo)
  let value = missingBounds
  const warnings = new Set<string>()

  return {
    get value() {
      return value
    },
    bind(targets, update) {
      const element = targets.get(target)
      const reference = targets.get(relativeTo)
      const document = (element ?? reference ?? targets.get('self'))?.ownerDocument
      let active = true
      let initializing = true

      if (!document) {
        value = missingBounds

        return () => {
          active = false
        }
      }

      const cleanup = registerLayoutRead(
        document,
        (batch) => {
          const next =
            !element || !reference
              ? missingBounds
              : batch.bounds(element, reference, (reason) => {
                  if (warnings.has(reason)) return

                  warnings.add(reason)
                  console.warn({ code: 'runtime.measure', message: reason })
                })

          return () => {
            if (
              !active ||
              (['x', 'y', 'width', 'height', 'attached'] as const).every(
                (key) => next[key] === value[key],
              )
            )
              return

            value = next
            if (initializing) return

            queueMicrotask(() => {
              if (active) update(value)
            })
          }
        },
        [element, reference].filter((item): item is HTMLElement => item !== undefined),
      )
      initializing = false

      return () => {
        active = false
        value = missingBounds
        cleanup()
      }
    },
  }
}
