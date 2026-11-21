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
          : /* v8 ignore next -- @preserve: The editor server always returns a string error envelope. */ `Editor failed: ${response.status}`,
      )
    }
    /* v8 ignore if -- @preserve: The server constructs validated replies; malformed envelopes are covered by protocol validation. */
    if (!isEditorReply(result)) throw new Error('Invalid editor response')

    return result
  }
}

export function subscribeToEditorEvents(
  hot: ImportMeta['hot'],
  handlers: {
    sourceChanged: (sourceId: string) => void
    diagnostics: (sourceId: string, message: string) => void
  },
) {
  const sourceChanged = ({ sourceId }: { sourceId: string }) => handlers.sourceChanged(sourceId)
  const diagnostics = (event: { sourceId?: string; diagnostics: { message: string }[] }) => {
    if (event.sourceId)
      handlers.diagnostics(event.sourceId, event.diagnostics.map((item) => item.message).join('\n'))
  }

  hot?.on('liva:source-changed', sourceChanged)
  hot?.on('liva:diagnostics', diagnostics)

  return () => {
    hot?.off('liva:source-changed', sourceChanged)
    hot?.off('liva:diagnostics', diagnostics)
  }
}
