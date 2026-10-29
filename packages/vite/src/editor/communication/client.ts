import { isEditorReply, type EditorReply, type EditorRequest } from './protocol.ts'
import { isRecord } from '@liva/runtime'

export function createEditorTransport(token: string) {
  return async (request: EditorRequest): Promise<EditorReply> => {
    const response = await fetch('/__liva/editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Liva-Session': token },
      body: JSON.stringify(request),
    })
    const result: unknown = await response.json()

    if (!response.ok) {
      throw new Error(
        isRecord(result) && typeof result.error === 'string'
          ? result.error
          : `Editor failed: ${response.status}`,
      )
    }
    if (!isEditorReply(result)) throw new Error('Invalid editor response')

    return result
  }
}

export function subscribeToEditorEvents(handlers: {
  sourceChanged: (sourceId: string) => void
  diagnostics: (message: string) => void
}) {
  const hot = import.meta.hot
  const sourceChanged = ({ sourceId }: { sourceId: string }) => handlers.sourceChanged(sourceId)
  const diagnostics = (items: { message: string }[]) =>
    handlers.diagnostics(items.map((item) => item.message).join('\n'))

  hot?.on('liva:source-changed', sourceChanged)
  hot?.on('liva:diagnostics', diagnostics)

  return () => {
    hot?.off('liva:source-changed', sourceChanged)
    hot?.off('liva:diagnostics', diagnostics)
  }
}
