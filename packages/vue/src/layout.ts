import { nextTick } from 'vue'
import { LayoutCoordinator } from '@liva/runtime/features/layout/layout-coordinator'
import type { RuntimeDiagnostic } from '@liva/runtime/core'

/** Coordinates capture before Vue mutations, including the removal of retained leave DOM. */
export function createLayoutSession(
  reconcile: () => void,
  report: (diagnostic: RuntimeDiagnostic) => void,
) {
  const failed = (error: unknown) => report({ code: 'vue.layout', message: String(error), error })
  const layout = new LayoutCoordinator(failed)
  let scheduled = false
  let disposed = false

  const start = () => {
    layout.begin()

    if (scheduled) return

    scheduled = true
    void nextTick()
      .then(() => {
        if (disposed) return undefined

        scheduled = false
        reconcile()
        layout.finish()

        return undefined
      })
      .catch(failed)
  }

  return {
    beforeMutation() {
      try {
        start()
      } catch (error) {
        failed(error)
        throw error
      }
    },
    beforeRemoval() {
      try {
        start()
      } catch (error) {
        // Capture failures must not strand the retained DOM.
        failed(error)
      }
    },
    register: layout.register.bind(layout),
    dispose() {
      disposed = true
      layout.dispose()
    },
  }
}
