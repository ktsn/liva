import { LivaPresenceBoundary, type PresenceEntry, type PresenceTarget } from './presence.ts'
import type { App, ComponentCustomOptions, DirectiveBinding, ObjectDirective, Plugin } from 'vue'
import {
  LivaInstance,
  type Definition,
  type RuntimeDiagnostic,
  type LifecycleSession,
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
          if (!entry.snapshots.has(target.registration))
            entry.snapshots.set(target.registration, work)
          entry.targets.delete(target.registration)
          queueMicrotask(() => entry.snapshots.delete(target.registration))
        }
      }

      const mount = (
        element: HTMLElement,
        binding: DirectiveBinding<string | Record<string, unknown>>,
      ) => {
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
          const runtime = new LivaInstance(definition, binding.value, report)
          runtime.onEvent = (name) =>
            element.dispatchEvent(new CustomEvent(`liva-${name}`, { bubbles: true }))
          let requestedState = runtime.state
          const record = {
            root: element,
            component,
            runtime,
            definition,
            get requestedState() {
              return typeof binding.value === 'string' ? requestedState : runtime.reactiveState
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
          options.observe?.('unmount', record)
          reconcile()
        }
      }

      const rootDirective: ObjectDirective<HTMLElement, string | Record<string, unknown>> = {
        created: mount,
        updated(element, binding) {
          const record = roots.get(element)

          if (!record || record.definition.name !== binding.arg) {
            unmount(element)
            mount(element, binding)
            return
          }

          if (typeof binding.value !== 'string') {
            record.runtime.updateParameters(binding.value ?? {})
          } else if (binding.value !== binding.oldValue) {
            if (!record.definition.states.some((state) => state.name === binding.value)) {
              record.runtime.setState(binding.value)
              return
            }

            record.requestedState = binding.value
            options.observe?.('update', record)
            record.runtime.setState(binding.value)
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

      app.component('LivaPresenceBoundary', LivaPresenceBoundary)
      app.directive('liva-owner', {
        created(element: HTMLElement, binding: DirectiveBinding<readonly unknown[]>) {
          explicitOwners.set(element, { owner: binding.instance!, key: binding.value })
        },
        unmounted(element: HTMLElement) {
          explicitOwners.delete(element)
        },
      })
      app.directive('liva-entry', {
        created(element: HTMLElement, binding: DirectiveBinding<PresenceEntry>) {
          binding.value.element = element
        },
        beforeUpdate(element: HTMLElement, binding: DirectiveBinding<PresenceEntry>) {
          binding.value.element = element
        },
      })
      app.directive('liva-lifecycle', {
        created(
          element: HTMLElement,
          binding: DirectiveBinding<{ owner: readonly unknown[]; entries: PresenceEntry[] }>,
        ) {
          const target = {
            owner: binding.instance!,
            key: binding.value.owner,
            entries: binding.value.entries,
            registration: {
              release() {
                const name = targets.get(element)?.name
                if (name) explicitRoot(target)?.runtime.releaseLifecycle([name], element)
              },
              retainEnter(session: LifecycleSession) {
                explicitRoot(target)?.runtime.retainEnter(session)
              },
              capture(phase: 'enter' | 'leave') {
                reconcileNow()
                const name = targets.get(element)?.name
                return name
                  ? (explicitRoot(target)?.runtime.captureLifecycle(phase, [name], element) ?? [])
                  : []
              },
            },
          }
          lifecycleTargets.set(element, target)
          for (const entry of target.entries) entry.targets.add(target.registration)
        },
        beforeUnmount(element: HTMLElement) {
          snapshotTarget(element)
          lifecycleTargets.delete(element)
        },
      })

      app.directive('liva', rootDirective)
      app.directive('liva-target', {
        created: bindTarget,
        updated: bindTarget,
        beforeUnmount(element: HTMLElement) {
          snapshotTarget(element)
          targets.delete(element)
          reconcile()
        },
      })
    },
  }
}
