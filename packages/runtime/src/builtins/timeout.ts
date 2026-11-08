import type { FunctionArguments, ReactiveCall, RuntimeValue } from '../reactive-value.ts'

function configuration(args: FunctionArguments) {
  const { when, duration } = args

  if (typeof when !== 'boolean') throw new Error('timeout when requires boolean')
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    throw new Error('timeout duration requires nonnegative finite milliseconds')
  }

  return { when, duration }
}

/** No timer exists until binding activates the call. Prepared updates never schedule work. */
export function timeout(args: FunctionArguments): ReactiveCall {
  let current = configuration(args)
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let publish: ((value: RuntimeValue) => void) | undefined

  function cancel() {
    revision++
    clearTimeout(timer)
    timer = undefined
  }

  function schedule() {
    cancel()
    if (!publish || !current.when || expired) return

    const scheduledRevision = revision
    const deadline = performance.now() + current.duration

    function tick() {
      if (scheduledRevision !== revision) return

      const remaining = deadline - performance.now()

      if (remaining > 0) {
        // Browsers store timer delays in a signed 32-bit integer. Long waits use chunks.
        timer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
        return
      }

      timer = undefined
      expired = true
      // A matching revision still owns the binding; every unbind increments revision.
      publish!(true)
    }

    timer = setTimeout(tick, Math.min(current.duration, 2_147_483_647))
  }

  return {
    get value() {
      return expired
    },
    prepareUpdate(nextArgs) {
      const next = configuration(nextArgs)
      const changed = next.when !== current.when || next.duration !== current.duration
      const nextExpired = changed ? false : expired

      return {
        value: nextExpired,
        commit() {
          current = next
          expired = nextExpired
          if (changed) schedule()
        },
        discard() {},
      }
    },
    bind(_targets, update) {
      publish = update
      schedule()

      return () => {
        publish = undefined
        cancel()
      }
    },
    dispose() {
      publish = undefined
      cancel()
    },
  }
}
