import { LivaPresenceBoundary, type PresenceEntry, type PresenceTarget } from './presence.ts'
import type { App, ComponentCustomOptions, DirectiveBinding, ObjectDirective, Plugin } from 'vue'
import {
  LivaInstance,
  type Definition,
  type RuntimeDiagnostic,
  type LifecycleSession,
  type LifecycleWork,
} from '@liva/runtime'

declare module 'vue' {
  interface ComponentCustomOptions {
    livaDefinitions?: readonly Definition[]
  }
}

export interface InstanceBinding {
  readonly root: HTMLElement
  readonly component: ComponentCustomOptions
  readonly runtime: LivaInstance
  readonly definition: Definition
  requestedState: string
}

export interface LivaOptions {
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void
  observe?: (event: 'mount' | 'update' | 'unmount', instance: InstanceBinding) => void
}

type MotionValue = string | Record<string, unknown> | undefined

interface PresenceBinding {
  value: MotionValue
  owner: readonly unknown[]
  entries?: PresenceEntry[]
}

// Only compiler-generated bindings use this modifier; authored parameter objects
// remain opaque, even when they contain value, owner, or entries properties.
function motionValue(binding: DirectiveBinding, previous = false): MotionValue {
  const value = previous ? binding.oldValue : binding.value
  return binding.modifiers.compiled ? value?.value : value
}

function sameKey(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function createLivaPlugin(options: LivaOptions = {}): Plugin {
  return {
    install(app: App) {
      const roots = new Map<HTMLElement, InstanceBinding>()
      const owners = new WeakMap<HTMLElement, object>()
      const targets = new Map<HTMLElement, { name: string; owner: object }>()
      const report = options.onDiagnostic ?? console.warn
      const explicitOwners = new Map<HTMLElement, { owner: object; key: readonly unknown[] }>()
      const lifecycleTargets = new Map<
        HTMLElement,
        {
          owner: object
          key: readonly unknown[]
          entries: PresenceEntry[]
          registration: PresenceTarget
        }
      >()
      const explicitRoot = (target: { owner: object; key: readonly unknown[] }) => {
        const element = [...explicitOwners].find(
          ([candidate, root]) =>
            roots.has(candidate) && root.owner === target.owner && sameKey(root.key, target.key),
        )?.[0]
        return element ? roots.get(element) : undefined
      }
      let scheduled = false

      const reconcileNow = () => {
        const bindings = new Map<InstanceBinding, [string, HTMLElement][]>()
        for (const root of roots.values()) bindings.set(root, [])

        for (const [element, target] of targets) {
          const explicit = lifecycleTargets.get(element)
          let root = explicit ? explicitRoot(explicit) : undefined

          if (!explicit) {
            let parent: HTMLElement | null = element
            while (parent && !roots.has(parent)) parent = parent.parentElement
            root = parent ? roots.get(parent) : undefined
          }

          if (root && owners.get(root.root) === target.owner) {
            bindings.get(root)!.push([target.name, element])
          }
        }

        for (const [root, entries] of bindings) root.runtime.bind(entries)
      }

      const reconcile = () => {
        if (scheduled) return
        scheduled = true

        queueMicrotask(() => {
          scheduled = false
          reconcileNow()
        })
      }

      const snapshotTarget = (element: HTMLElement) => {
        const target = lifecycleTargets.get(element)
        if (!target) return
        const work = target.registration.capture('leave')

        for (const entry of target.entries) {
          /* v8 ignore else -- @preserve: Vue tears down each target once; this guard only preserves an earlier snapshot if teardown hooks overlap. */
          if (!entry.snapshots.has(target.registration))
            entry.snapshots.set(target.registration, work)
          entry.targets.delete(target.registration)
          queueMicrotask(() => entry.snapshots.delete(target.registration))
        }
      }

      const mount = (element: HTMLElement, binding: DirectiveBinding) => {
        const component: ComponentCustomOptions | undefined = binding.instance?.$options
        const definition = component?.livaDefinitions?.find((d) => d.name === binding.arg)

        if (!component || !definition) {
          report({
            code: 'vue.definition',
            message: `Unknown component Liva definition: ${binding.arg}`,
          })
          return
        }

        try {
          const value = motionValue(binding)
          const runtime = new LivaInstance(definition, value, report)
          runtime.onEvent = (name) =>
            element.dispatchEvent(new CustomEvent(`liva-${name}`, { bubbles: true }))
          let requestedState = runtime.state
          const record = {
            root: element,
            component,
            runtime,
            definition,
            get requestedState() {
              return typeof value === 'string' ? requestedState : runtime.reactiveState
            },
            set requestedState(state: string) {
              requestedState = state
            },
          }
          runtime.onReactiveState = (state) => {
            record.requestedState = state
            options.observe?.('update', record)
          }
          roots.set(element, record)
          owners.set(element, binding.instance!)

          if (binding.modifiers.compiled) {
            explicitOwners.set(element, { owner: binding.instance!, key: binding.value.owner })
          }

          options.observe?.('mount', record)
          reconcile()
        } catch (error) {
          report({ code: 'vue.state', message: String(error), error })
        }
      }

      const unmount = (element: HTMLElement) => {
        const record = roots.get(element)

        if (record) {
          for (const [target, registration] of lifecycleTargets) {
            if (explicitRoot(registration) === record) snapshotTarget(target)
          }
          record.runtime.dispose()
          roots.delete(element)
          explicitOwners.delete(element)
          options.observe?.('unmount', record)
          reconcile()
        }
      }

      const rootDirective: ObjectDirective<HTMLElement, MotionValue | PresenceBinding> = {
        created: mount,
        updated(element, binding) {
          const record = roots.get(element)

          if (!record || record.definition.name !== binding.arg) {
            unmount(element)
            mount(element, binding)
            return
          }

          const value = motionValue(binding)
          const oldValue = motionValue(binding, true)

          if (typeof value !== 'string') {
            record.runtime.updateParameters(value ?? {})
          } else if (value !== oldValue) {
            if (!record.definition.states.some((state) => state.name === value)) {
              record.runtime.setState(value)
              return
            }

            record.requestedState = value
            options.observe?.('update', record)
            record.runtime.setState(value)
          }

          reconcile()
        },
        beforeUnmount: unmount,
      }

      const bindTarget = (element: HTMLElement, binding: DirectiveBinding) => {
        if (binding.arg && binding.instance) {
          targets.set(element, { name: binding.arg, owner: binding.instance })
        } else {
          targets.delete(element)
        }

        reconcile()
      }

      const registerLifecycleTarget = (
        element: HTMLElement,
        binding: DirectiveBinding<PresenceBinding & { entries: PresenceEntry[] }>,
      ) => {
        if (!binding.modifiers.compiled) return

        const target = {
          owner: binding.instance!,
          key: binding.value.owner,
          entries: binding.value.entries,
          registration: {
            release(work: readonly LifecycleWork[]) {
              const name = targets.get(element)?.name
              /* v8 ignore else -- @preserve: Compiled lifecycle targets always have a static target argument. */
              if (name)
                explicitRoot(target)?.runtime.releaseLifecycle(
                  [name],
                  element,
                  work
                    .filter((item) => item.element === element && item.track.target === name)
                    .map((item) => item.track.property),
                )
            },
            retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
              explicitRoot(target)?.runtime.retainLifecycle(phase, session)
            },
            capture(phase: 'enter' | 'leave') {
              reconcileNow()
              const name = targets.get(element)?.name
              return name
                ? (explicitRoot(target)?.runtime.captureLifecycle(phase, [name], element) ?? [])
                : /* v8 ignore next -- @preserve: Compiled lifecycle targets always have a static target argument. */ []
            },
          },
        }
        lifecycleTargets.set(element, target)
        for (const entry of target.entries) entry.targets.add(target.registration)
      }

      app.component('LivaPresenceBoundary', LivaPresenceBoundary)
      app.directive('liva-entry', {
        created(element: HTMLElement, binding: DirectiveBinding<PresenceEntry>) {
          binding.value.element = element
        },
        beforeUpdate(element: HTMLElement, binding: DirectiveBinding<PresenceEntry>) {
          binding.value.element = element
        },
      })

      app.directive('liva', rootDirective)
      app.directive('liva-target', {
        created(element, binding) {
          bindTarget(element, binding)
          registerLifecycleTarget(element, binding)
        },
        updated: bindTarget,
        beforeUnmount(element: HTMLElement) {
          snapshotTarget(element)
          lifecycleTargets.delete(element)
          targets.delete(element)
          reconcile()
        },
      })
    },
  }
}
