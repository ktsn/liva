import { createLivaPlugin } from '@liva/vue/runtime'
import type { Edit } from './communication/protocol.ts'
import { createEditorTransport, subscribeToEditorEvents } from './communication/client.ts'
import { EditorController } from './controller.ts'
import { mountEditor } from './ui.ts'

/** The consuming dev server provides the session token and the virtual module's HMR context. */
export function createDevPlugin(token: string, hot: ImportMeta['hot']) {
  const controller = new EditorController(createEditorTransport(token))
  const unmount = mountEditor(controller)
  const unsubscribe = subscribeToEditorEvents(hot, {
    sourceChanged: (sourceId) => controller.sourceChanged(sourceId),
    diagnostics: (sourceId, message) => controller.reportSourceDiagnostics(sourceId, message),
  })
  hot?.dispose(() => {
    unsubscribe()
    unmount()
  })

  Object.assign(window, { __LIVA_EDITOR__: controller })
  return createLivaPlugin({
    source: (component) => component.livaSource,
    observe: (event, binding) => controller.observe(event, binding),
    onDiagnostic: (diagnostic) => controller.report(diagnostic.message),
  })
}

export type { Edit }
