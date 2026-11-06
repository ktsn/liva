import { isArrayOf, isDefinition, isFrame, isRecord, type Definition } from '@liva/runtime'

export type Edit =
  | { op: 'easing'; path: string; value?: string }
  | { op: 'timing'; path: string; value?: string }
  | { op: 'set'; path: string; value: string }
  | { op: 'removeFrame'; path: string }
  | { op: 'addFrame'; path: string; offset: number; value: string; easing?: string }

export interface EditorRequest {
  action: 'inspect' | 'preview' | 'commit'
  sourceId: string
  definition: string
  instanceId?: string
  baseHash?: string
  sequence?: number
  edits?: Edit[]
  requestId?: string
}

export interface Inspection {
  hash: string
  definition: Definition
  fields: {
    path: string
    kind: 'value' | 'block'
    value: string
    range?: { start: number; end: number }
  }[]
}

export interface EditorReply extends Inspection {
  sequence?: number
}

declare module 'vue' {
  interface ComponentCustomOptions {
    livaSource?: string
  }
}

function isEdit(value: unknown): value is Edit {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string') return false

  switch (value.op) {
    case 'easing':
    case 'timing':
      return value.value === undefined || typeof value.value === 'string'
    case 'set':
      return typeof value.value === 'string'
    case 'removeFrame':
      return true
    case 'addFrame':
      return isFrame(value)
    default:
      return false
  }
}

export function isEditorRequest(value: unknown): value is EditorRequest {
  return (
    isRecord(value) &&
    (value.action === 'inspect' || value.action === 'preview' || value.action === 'commit') &&
    typeof value.sourceId === 'string' &&
    typeof value.definition === 'string' &&
    ['instanceId', 'baseHash', 'requestId'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.sequence === undefined || typeof value.sequence === 'number') &&
    (value.edits === undefined || isArrayOf(value.edits, isEdit))
  )
}

function isField(value: unknown): value is Inspection['fields'][number] {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (value.kind === 'value' || value.kind === 'block') &&
    typeof value.value === 'string' &&
    (value.range === undefined ||
      (isRecord(value.range) &&
        typeof value.range.start === 'number' &&
        typeof value.range.end === 'number' &&
        Number.isSafeInteger(value.range.start) &&
        Number.isSafeInteger(value.range.end) &&
        value.range.start >= 0 &&
        value.range.end >= value.range.start))
  )
}

export function isEditorReply(value: unknown): value is EditorReply {
  return (
    isRecord(value) &&
    typeof value.hash === 'string' &&
    isDefinition(value.definition) &&
    isArrayOf(value.fields, isField) &&
    (value.sequence === undefined || typeof value.sequence === 'number')
  )
}
