import type { PreviewOperation } from './preview-operation.ts'
import type { StyleWrite } from './presentation-planner.ts'
import type { BrowserExecutor } from './browser-executor.ts'

export class PreviewExecution {
  private readonly host: Pick<
    BrowserExecutor,
    | 'releaseLayout'
    | 'setControllerPreview'
    | 'presented'
    | 'presentationMode'
    | 'cancel'
    | 'restore'
    | 'propertyMotion'
    | 'dirtyProperties'
    | 'onLayoutChange'
    | 'applyWrites'
    | 'environment'
    | 'active'
  >

  constructor(
    host: Pick<
      BrowserExecutor,
      | 'releaseLayout'
      | 'setControllerPreview'
      | 'presented'
      | 'presentationMode'
      | 'cancel'
      | 'restore'
      | 'propertyMotion'
      | 'dirtyProperties'
      | 'onLayoutChange'
      | 'applyWrites'
      | 'environment'
      | 'active'
    >,
  ) {
    this.host = host
  }

  private previewRevision = 0

  beginPreview(writes: readonly StyleWrite[]) {
    this.host.releaseLayout()
    this.previewRevision++

    this.host.setControllerPreview(true)

    this.host.presented.clear()
    this.host.presentationMode = 'preparing-preview'
    this.host.cancel(true, true)
    this.host.restore()
    this.host.propertyMotion.reset()
    this.host.dirtyProperties.clear()
    this.host.presentationMode = 'preparing-preview'
    this.host.onLayoutChange?.()
    this.host.applyWrites(writes)
  }

  /** Restores ordinary ownership from displayed CSS before accepting another input delta. */
  abortPreview() {
    this.previewRevision++
    this.host.cancel()
    this.host.restore()
    this.host.environment?.refreshOwnership()
    this.host.environment?.reconcile()
  }

  endCompositionPreview(): void {
    if (this.host.presentationMode === 'live') return

    this.abortPreview()
  }

  /** Issues a generation-scoped capability; continuing live leave effects are never scrubbed. */
  completePreview(): PreviewOperation {
    const revision = this.previewRevision
    const effects = new Set(
      this.host.active.filter((entry) => entry.preview).map((entry) => entry.id),
    )
    const current = () =>
      revision === this.previewRevision && this.host.presentationMode === 'preview'

    return Object.freeze({
      seek: (milliseconds: number) => {
        if (!current() || !Number.isFinite(milliseconds)) return

        for (const entry of this.host.active) {
          if (entry.preview && effects.has(entry.id))
            entry.animation.currentTime = Math.max(0, milliseconds)
        }
      },
      end: () => {
        if (current()) this.endCompositionPreview()
      },
    })
  }
}
