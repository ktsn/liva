import type { ReactiveSubscription, RuntimeValue } from '../reactive-value.ts'

const selectors = {
  hover: ':hover',
  active: ':active',
  focus: ':focus',
  focusVisible: ':focus-visible',
  focusWithin: ':focus-within',
} as const

const members = ['hover', 'active', 'focus', 'focusVisible', 'focusWithin'] as const

type InteractionValue = { readonly [Key in keyof typeof selectors]: boolean }

function snapshot(element?: HTMLElement): InteractionValue {
  return {
    hover: element?.matches(selectors.hover) ?? false,
    active: element?.matches(selectors.active) ?? false,
    focus: element?.matches(selectors.focus) ?? false,
    focusVisible: element?.matches(selectors.focusVisible) ?? false,
    focusWithin: element?.matches(selectors.focusWithin) ?? false,
  }
}

export function interaction(args: Readonly<Record<string, RuntimeValue>>): ReactiveSubscription {
  const target = args.target

  if (typeof target !== 'object' || typeof target.name !== 'string') {
    throw new Error('interaction requires a target value')
  }

  const targetName = target.name
  let value = snapshot()

  return {
    get value() {
      return value
    },
    bind(targets, update) {
      const element = targets.get(targetName)
      value = snapshot(element)

      if (!element) return () => {}

      const document = element.ownerDocument
      const view = document.defaultView

      if (!view) throw new Error('interaction requires a target with a browsing context')

      let frame: number | undefined
      let disposed = false

      const recheck = () => {
        const next = snapshot(element)

        if (members.every((key) => next[key] === value[key])) return

        value = next
        update(next)
      }

      const trigger = () => {
        recheck()

        if (disposed || frame !== undefined) return

        // Default actions and pseudo-class updates can run after event dispatch.
        frame = view.requestAnimationFrame(() => {
          frame = undefined
          recheck()
        })
      }
      const events = [
        'pointerover',
        'pointerout',
        'pointerdown',
        'pointerup',
        'pointercancel',
        'pointermove',
        'mouseover',
        'mouseout',
        'mousedown',
        'mouseup',
        'mousemove',
        'focusin',
        'focusout',
        'keydown',
        'keyup',
        'click',
        'visibilitychange',
        'gotpointercapture',
        'lostpointercapture',
      ]

      for (const event of events) document.addEventListener(event, trigger, true)

      view.addEventListener('blur', trigger)
      view.addEventListener('focus', trigger)

      return () => {
        disposed = true

        for (const event of events) document.removeEventListener(event, trigger, true)

        view.removeEventListener('blur', trigger)
        view.removeEventListener('focus', trigger)

        if (frame !== undefined) view.cancelAnimationFrame(frame)

        value = snapshot()
      }
    },
  }
}
