import {
  type Component,
  defineComponent,
  h,
  onBeforeUnmount,
  Transition,
  TransitionGroup,
} from 'vue'
import { LifecycleSession, type LifecycleWork } from '@liva/runtime'

export interface PresenceTarget {
  capture(phase: 'enter' | 'leave'): LifecycleWork[]
  retainEnter(session: LifecycleSession): void
  release(): void
}

export class PresenceEntry {
  element?: HTMLElement
  readonly targets = new Set<PresenceTarget>()
  readonly snapshots = new Map<PresenceTarget, LifecycleWork[]>()
  session?: LifecycleSession
  leaving = false

  capture(phase: 'enter' | 'leave') {
    const work = [...this.targets].flatMap((target) => target.capture(phase))
    if (phase === 'leave') work.push(...[...this.snapshots.values()].flat())
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

      let work = entry.capture(phase)
      if (entry.session) {
        work = work.map(({ element: target, track }) => ({
          element: target,
          track: {
            ...track,
            keyframes: track.keyframes.map((frame, index) =>
              index === 0
                ? { ...frame, value: getComputedStyle(target).getPropertyValue(track.property) }
                : frame,
            ),
          },
        }))
      }
      for (const target of entry.targets) target.release()
      entry.leaving = phase === 'leave'
      entry.cancel('superseded')
      entry.session = new LifecycleSession(work, phase)
      entry.session.initialize()
      if (phase === 'enter') {
        for (const target of entry.targets) target.retainEnter(entry.session)
      }
    }
    const run = (element: Element, done: () => void) => {
      const entry = find(element)
      const session = entry?.session
      if (!session) {
        done()
        return
      }

      const complete = (result: import('@liva/runtime').LifecycleResult) => {
        if (entry.session !== session) return
        entry.session = undefined
        if (
          result === 'completed' ||
          result === 'failed' ||
          (result === 'superseded' && !entry.leaving)
        )
          done()

        if (!props.persisted && !element.isConnected) {
          for (const [key, candidate] of entries) {
            if (candidate === entry) entries.delete(key)
          }
          entry.dispose()
          retained.delete(entry)
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
