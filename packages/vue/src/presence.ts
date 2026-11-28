import {
  type App,
  type Component,
  defineComponent,
  h,
  onBeforeUnmount,
  Transition,
  TransitionGroup,
} from 'vue'
import { PresenceOperation, type PresenceCapture } from '@liva/runtime'

/** Register the public Presence assets used by authored templates. */
export function registerPresence(app: App) {
  app.component('LivaPresenceBoundary', LivaPresenceBoundary)
  app.directive('liva-entry', livaEntry)
}

export interface PresenceTarget {
  capture(phase: 'enter' | 'leave', interrupted: boolean): PresenceCapture | undefined
}

export class PresenceEntry {
  element?: HTMLElement
  beforeMutation?: () => void
  readonly targets = new Set<PresenceTarget>()
  readonly snapshots = new Map<PresenceTarget, PresenceCapture>()
  session?: PresenceOperation
  leaving = false

  capture(phase: 'enter' | 'leave') {
    const work = [...this.targets].flatMap((target) => {
      const capture = target.capture(phase, this.session !== undefined)

      return capture ? [capture] : []
    })

    if (phase === 'leave') work.push(...this.snapshots.values())
    this.snapshots.clear()
    return work
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.session?.cancel(reason)
    this.session = undefined
  }

  dispose() {
    this.cancel('owner-teardown')
    this.targets.clear()
    this.snapshots.clear()
    this.element = undefined
    this.beforeMutation = undefined
  }
}

export const LivaPresenceBoundary = defineComponent({
  name: 'LivaPresenceBoundary',
  props: { group: Boolean, persisted: Boolean },
  setup(props, { slots }) {
    const entries = new Map<unknown, PresenceEntry>()
    const retained = new Set<PresenceEntry>()
    const item = (key: unknown) => {
      let entry = entries.get(key)
      if (!entry || (entry.leaving && !props.persisted)) {
        entry = new PresenceEntry()
        entries.set(key, entry)
        retained.add(entry)
      }
      return entry
    }
    const find = (element: Element) => [...retained].find((entry) => entry.element === element)
    const prepare = (element: Element, phase: 'enter' | 'leave') => {
      const entry = find(element)
      if (!entry) return

      const captures = entry.capture(phase)
      const previous = entry.session
      const operation = new PresenceOperation(captures, phase)

      entry.leaving = phase === 'leave'
      entry.session = operation
      operation.initialize(previous)
    }
    const run = (element: Element, done: () => void) => {
      const entry = find(element)
      const session = entry?.session
      if (!session) {
        done()
        return
      }

      const complete = (result: import('@liva/runtime').PresenceResult) => {
        if (entry.session !== session) return
        entry.session = undefined
        try {
          if (
            result === 'completed' ||
            result === 'failed' ||
            (result === 'superseded' && !entry.leaving)
          ) {
            try {
              entry.beforeMutation?.()
            } finally {
              // Capture failure cannot retain DOM after operation completion.
              done()
            }
          }
        } finally {
          if (!props.persisted && !element.isConnected) {
            for (const [key, candidate] of entries) {
              if (candidate === entry) entries.delete(key)
            }
            entry.dispose()
            retained.delete(entry)
          }
        }
      }
      void session.finished.then(complete)
      session.play()
    }
    const cancel = (element: Element) => find(element)?.cancel('superseded')

    onBeforeUnmount(() => {
      for (const entry of retained) entry.dispose()
      entries.clear()
      retained.clear()
    })

    return () =>
      h(
        (props.group ? TransitionGroup : Transition) as Component,
        {
          css: false,
          appear: true,
          persisted: props.persisted,
          onBeforeEnter: (element: Element) => prepare(element, 'enter'),
          onEnter: run,
          onEnterCancelled: cancel,
          onBeforeLeave: (element: Element) => prepare(element, 'leave'),
          onLeave: run,
          onLeaveCancelled: cancel,
        },
        { default: () => slots.default?.({ item }) },
      )
  },
})

/** Connects the compiler's structural element to its local Presence entry. */
export const livaEntry: import('vue').ObjectDirective<HTMLElement, PresenceEntry> = {
  created(element, binding) {
    binding.value.element = element
  },
  beforeUpdate(element, binding) {
    binding.value.element = element
  },
}
