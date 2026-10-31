import type { MotionParameter, Source } from './definition.ts'
import type { DragValue, SourceValues } from './expression.ts'

export function initialSources(sources: readonly Source[]): Record<string, DragValue> {
  return Object.fromEntries(
    sources.map((source) => [source.name, { active: false, offset: { x: 0, y: 0 } }]),
  )
}

export function parameterValues(
  parameters: readonly MotionParameter[],
  values: SourceValues,
  inputs: Readonly<Record<string, unknown>>,
): SourceValues {
  const next = { ...values }

  for (const name of Object.keys(inputs)) {
    if (!parameters.some((parameter) => parameter.name === name)) {
      throw new Error(`Unknown motion parameter: ${name}`)
    }
  }

  for (const parameter of parameters) {
    if (!Object.hasOwn(inputs, parameter.name)) {
      throw new Error(`Missing motion parameter: ${parameter.name}`)
    }

    const value = inputs[parameter.name]

    if (typeof value !== parameter.type || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`Motion parameter ${parameter.name} requires ${parameter.type}`)
    }

    Object.defineProperty(next, parameter.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
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
