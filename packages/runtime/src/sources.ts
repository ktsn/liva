import type { Source } from './definition.ts'
import type { DragValue, SourceValues } from './expression.ts'

export function initialSources(sources: readonly Source[]): Record<string, boolean | DragValue> {
  return Object.fromEntries(
    sources.map((source) => [
      source.name,
      source.kind === 'external' ? false : { active: false, offset: { x: 0, y: 0 } },
    ]),
  )
}

export function externalValues(
  sources: readonly Source[],
  values: SourceValues,
  inputs: Readonly<Record<string, unknown>>,
): Record<string, boolean | DragValue> {
  const next = { ...values }

  for (const source of sources) {
    if (source.kind !== 'external') continue
    const value = Object.hasOwn(inputs, source.name) ? inputs[source.name] : false
    if (typeof value !== 'boolean')
      throw new Error(`External source ${source.name} requires Boolean`)
    next[source.name] = value
  }

  return next
}

export function bindDrag(element: HTMLElement, update: (value: DragValue) => void): () => void {
  let pointer: number | undefined
  let origin = { x: 0, y: 0 }
  let offset = { x: 0, y: 0 }

  const finish = (event?: PointerEvent) => {
    if (pointer === undefined || (event && event.pointerId !== pointer)) return
    const captured = pointer
    pointer = undefined
    if (element.hasPointerCapture(captured)) element.releasePointerCapture(captured)
    update({ active: false, offset })
  }

  const down = (event: PointerEvent) => {
    if (pointer !== undefined || !event.isPrimary || event.button !== 0) return
    element.setPointerCapture(event.pointerId)
    pointer = event.pointerId
    origin = { x: event.clientX, y: event.clientY }
    offset = { x: 0, y: 0 }
    update({ active: true, offset })
  }

  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    offset = { x: event.clientX - origin.x, y: event.clientY - origin.y }
    update({ active: true, offset })
  }

  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    move(event)
    finish(event)
  }

  element.addEventListener('pointerdown', down)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', up)
  element.addEventListener('pointercancel', finish)
  element.addEventListener('lostpointercapture', finish)

  return () => {
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', finish)
    element.removeEventListener('lostpointercapture', finish)
    if (pointer !== undefined && element.hasPointerCapture(pointer))
      element.releasePointerCapture(pointer)
    pointer = undefined
  }
}
