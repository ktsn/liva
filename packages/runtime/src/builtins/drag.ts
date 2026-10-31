import type { ReactiveSubscription, RuntimeValue } from '../reactive-value.ts'

interface DragValue {
  readonly active: boolean
  readonly offset: { readonly x: number; readonly y: number }
}

export function drag(args: Readonly<Record<string, RuntimeValue>>): ReactiveSubscription {
  const target = args.target

  if (typeof target !== 'object' || typeof target.name !== 'string') {
    throw new Error('drag requires a target value')
  }

  const targetName = target.name

  let value: DragValue = { active: false, offset: { x: 0, y: 0 } }

  return {
    get value() {
      return { active: value.active, offset: value.offset }
    },
    bind(targets, update) {
      const element = targets.get(targetName)

      if (!element) throw new Error(`Unknown target: ${targetName}`)

      const cleanup = bindDrag(element, (next) => {
        value = next
        update({ active: value.active, offset: value.offset })
      })

      return () => {
        cleanup()
        value = { ...value, active: false }
      }
    },
  }
}

function bindDrag(element: HTMLElement, update: (value: DragValue) => void): () => void {
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
