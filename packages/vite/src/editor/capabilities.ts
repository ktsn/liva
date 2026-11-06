import type { Definition } from '@liva/runtime'

export const readOnlyMessage =
  'Layer motions and typed decorators are read-only in the timeline editor. Edit the Liva source and use application controls to preview them.'

export function timelineReadOnly(definition: Definition): boolean {
  return (
    !!definition.layers?.length ||
    JSON.stringify(definition).includes('"timingExpression":') ||
    JSON.stringify(definition).includes('"easingExpression":')
  )
}
