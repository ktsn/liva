import { LivaPresenceBoundary, type PresenceEntry, type PresenceTarget } from './presence.ts'
import { nextTick } from 'vue'
import type { App, ComponentCustomOptions, DirectiveBinding, ObjectDirective, Plugin } from 'vue'
import {
  Runtime,
  LayoutCoordinator,
  RuntimeInspection,
  PresentationExecutor,
  ROOT_TARGET,
  rootTargetBindings,
  type Definition,
  type RuntimeDiagnostic,
} from '@liva/runtime'

declare module 'vue' {
  interface ComponentCustomOptions {
    livaDefinitions?: readonly Definition[]
  }
}

/** Plain viewport-relative CSS-pixel bounds, read only when requested. */
export interface InstanceBounds {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly width: number
  readonly height: number
}

/** Editor/integration capabilities; target elements and native execution remain private to Vue. */
export interface InstanceBinding {
  readonly label: string
  /** Optional opaque source identity supplied by the integration, never a filesystem path. */
  readonly source?: string
  readonly runtime: Runtime
  readonly inspection: RuntimeInspection
  readonly definition: Definition

  /** Reads current viewport geometry; returns undefined after this registration unmounts. */
  bounds(): InstanceBounds | undefined
}

interface RootBinding {
  readonly root: HTMLElement
  readonly runtime: Runtime
  readonly executor: PresentationExecutor
  readonly definition: Definition
  readonly releaseLayout: () => void
  readonly observed: Omit<InstanceBinding, 'label'> & { label: string }
}

export interface LivaOptions {
  /**
   * Extracts an optional opaque source identity before Runtime construction.
   * A thrown error reports vue.initialization and aborts assembly. Development
   * integration reads compiler mappings here; production needs no source metadata.
   */
  source?: (component: ComponentCustomOptions) => string | undefined
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void
  observe?: (event: 'mount' | 'update' | 'unmount', instance: InstanceBinding) => void
}

type MotionValue = Record<string, unknown> | undefined

interface PresenceBinding {
  value: MotionValue
  owner: readonly unknown[]
  entries?: PresenceEntry[]
}

// Only compiler-generated bindings use this modifier; authored parameter objects
// remain opaque, even when they contain value, owner, or entries properties.
function motionValue(binding: DirectiveBinding): MotionValue {
  const value = binding.value
  return binding.modifiers.compiled ? value?.value : value
}

function isCompiledBinding(
  binding: DirectiveBinding,
): binding is DirectiveBinding<PresenceBinding> {
  return !!binding.modifiers.compiled
}

function sameKey(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function createLivaPlugin(options: LivaOptions = {}): Plugin {
  return {
    install(app: App) {
      const roots = new Map<HTMLElement, RootBinding>()
      const owners = new WeakMap<HTMLElement, object>()
      const targets = new Map<HTMLElement, { name: string; owner: object }>()
      const report = options.onDiagnostic ?? console.warn
      const explicitOwners = new Map<HTMLElement, { owner: object; key: readonly unknown[] }>()
      const lifecycleTargets = new Map<
        HTMLElement,
        {
          owner: object
          key: readonly unknown[]
          names: Set<string>
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
      const layout = new LayoutCoordinator((error) =>
        report({ code: 'vue.layout', message: String(error), error }),
      )
      let layoutScheduled = false
      const startMutation = () => {
        layout.begin()
        if (layoutScheduled) return

        layoutScheduled = true
        void nextTick()
          .then(() => {
            layoutScheduled = false
            reconcileNow()
            layout.finish()
            return undefined
          })
          .catch((error) => report({ code: 'vue.layout', message: String(error), error }))
      }
      const beforeMutation = () => {
        try {
          startMutation()
        } catch (error) {
          report({ code: 'vue.layout', message: String(error), error })
          throw error
        }
      }
      const beforeRemoval = () => {
        try {
          startMutation()
        } catch (error) {
          // A failed capture is monitored, but must not strand Presence's retained
          // DOM after its operation has already completed.
          report({ code: 'vue.layout', message: String(error), error })
        }
      }

      app.mixin({
        beforeMount: beforeMutation,
        beforeUpdate: beforeMutation,
        beforeUnmount: beforeMutation,
      })
      app.onUnmount(() => layout.dispose())
      let scheduled = false

      const reconcileNow = () => {
        const bindings = new Map<RootBinding, [string, HTMLElement][]>()

        for (const root of roots.values()) {
          bindings.set(root, [])
        }

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

        for (const [root, entries] of bindings) {
          root.executor.bind(rootTargetBindings(root.root, entries))
        }
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
        const work = target.registration.capture(
          'leave',
          target.entries.some((entry) => entry.session !== undefined),
        )

        for (const entry of target.entries) {
          /* v8 ignore else -- @preserve: Vue tears down each target once; this guard only preserves an earlier snapshot if teardown hooks overlap. */
          if (work && !entry.snapshots.has(target.registration))
            entry.snapshots.set(target.registration, work)
          entry.beforeMutation = beforeRemoval
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
          const source = options.source?.(component)
          const executor = new PresentationExecutor(report)
          let runtime: Runtime | undefined

          try {
            runtime = new Runtime(executor, definition, value === undefined ? {} : value, report)
            executor.attach(runtime.environment)
          } catch (error) {
            try {
              if (runtime) runtime.dispose()
              else executor.dispose()
            } catch (cleanupError) {
              report({
                code: 'vue.initialization-cleanup',
                message: String(cleanupError),
                error: cleanupError,
              })
            }

            throw error
          }
          runtime.onEvent = (name) =>
            element.dispatchEvent(new CustomEvent(`liva-${name}`, { bubbles: true }))
          const inspection = new RuntimeInspection(runtime, executor, report)
          const observed = {
            label: definition.name,
            source,
            runtime,
            inspection,
            get definition() {
              return runtime.definition
            },
            bounds() {
              if (roots.get(element) !== record) return undefined

              const { top, bottom, left, right, width, height } = element.getBoundingClientRect()

              return { top, bottom, left, right, width, height }
            },
          }
          const record: RootBinding = {
            root: element,
            runtime,
            executor,
            definition,
            observed,
            releaseLayout: layout.register(executor),
          }
          runtime.onUpdate = () => options.observe?.('update', observed)
          roots.set(element, record)
          owners.set(element, binding.instance!)

          if (binding.modifiers.compiled) {
            explicitOwners.set(element, { owner: binding.instance!, key: binding.value.owner })
          }

          reconcile()
        } catch (error) {
          report({ code: 'vue.initialization', message: String(error), error })
        }
      }

      const unmount = (element: HTMLElement) => {
        const record = roots.get(element)

        if (record) {
          for (const [target, registration] of lifecycleTargets) {
            if (explicitRoot(registration) === record) snapshotTarget(target)
          }
          try {
            record.releaseLayout()
          } catch (error) {
            report({ code: 'vue.layout-disposal', message: String(error), error })
          }

          try {
            record.runtime.dispose()
          } catch (error) {
            report({ code: 'vue.disposal', message: String(error), error })
          } finally {
            roots.delete(element)
            owners.delete(element)
            explicitOwners.delete(element)

            try {
              options.observe?.('unmount', record.observed)
            } finally {
              reconcile()
            }
          }
        }
      }

      const observeMount = (element: HTMLElement) => {
        const record = roots.get(element)
        if (!record) return

        // Vue has now populated attributes/children from its created-hook setup.
        record.observed.label =
          element.getAttribute('aria-label') ??
          `${record.definition.name} ${element.textContent.trim().slice(0, 30)}`
        options.observe?.('mount', record.observed)
      }

      const rootDirective: ObjectDirective<HTMLElement, MotionValue | PresenceBinding> = {
        created(element, binding) {
          mount(element, binding)
          registerLifecycleTarget(element, binding, ROOT_TARGET)
        },
        mounted: observeMount,
        updated(element, binding) {
          const record = roots.get(element)

          if (!record || record.definition.name !== binding.arg) {
            unmount(element)
            mount(element, binding)
            observeMount(element)
            return
          }

          const value = motionValue(binding)
          record.runtime.updateParameters(value ?? {})

          reconcile()
        },
        beforeUnmount(element) {
          snapshotTarget(element)
          lifecycleTargets.delete(element)
          unmount(element)
        },
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
        binding: DirectiveBinding<PresenceBinding | MotionValue>,
        name = binding.arg,
      ) => {
        if (!isCompiledBinding(binding)) return

        const value = binding.value
        const entries = value.entries

        if (!entries) return

        // Presence metadata is generated only for static target arguments; roots pass self.
        const targetName = name!
        const existing = lifecycleTargets.get(element)

        if (existing) {
          // Two aliases on one element share the compiler-planned boundary entries.
          existing.names.add(targetName)

          return
        }

        const target = {
          owner: binding.instance!,
          names: new Set([targetName]),
          key: value.owner,
          entries,
          registration: {
            capture(phase: 'enter' | 'leave', interrupted: boolean) {
              reconcileNow()

              return explicitRoot(target)?.executor.capturePresence(phase, [...target.names], {
                element,
                interrupted,
              })
            },
          },
        }
        lifecycleTargets.set(element, target)
        for (const entry of target.entries) {
          entry.beforeMutation = beforeRemoval
          entry.targets.add(target.registration)
        }
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
