import { createLivaPlugin } from '@liva/vue/runtime'
import type { Edit } from './communication/protocol.ts'
import { createEditorTransport, subscribeToEditorEvents } from './communication/client.ts'
import { EditorController } from './controller.ts'
import { mountEditor } from './ui.ts'

export function createDevPlugin(token: string) {
  const controller = new EditorController(createEditorTransport(token))
  mountEditor(controller)
  const unsubscribe = subscribeToEditorEvents({
    sourceChanged: (sourceId) => controller.sourceChanged(sourceId),
    diagnostics: (sourceId, message) => controller.reportSourceDiagnostics(sourceId, message),
  })
  import.meta.hot?.dispose(unsubscribe)
  Object.assign(window, { __LIVA_EDITOR__: controller })
  return createLivaPlugin({
    source: (component) => component.livaSource,
    observe: (event, binding) => controller.observe(event, binding),
    onDiagnostic: (diagnostic) => controller.report(diagnostic.message),
  })
}

export type { Edit }
