import type { LivaPresenceBoundary } from './presence.ts'
import type { PresenceBinding, PresenceBindings } from './presence-bindings.ts'
import type { createLayoutSession } from './layout.ts'
import type { App, ComponentCustomOptions, DirectiveBinding, ObjectDirective, Plugin } from 'vue'
import {
  MotionRuntime,
  BrowserExecutor,
  ROOT_TARGET,
  rootTargetBindings,
  releaseResources,
  type Definition,
  type MotionFeatures,
  type RuntimeDiagnostic,
} from '@liva/runtime/core'
import type { Runtime, RuntimeInspection } from '@liva/runtime'

export interface CompiledMotionFeatures extends MotionFeatures {
  readonly layoutSession?: typeof createLayoutSession
}

declare module 'vue' {
  interface ComponentCustomOptions {
    /** Opaque source identity attached by the Vite development plugin. */
    livaSource?: string
    livaDefinitions?: readonly Definition[]
    livaFeatures?: Readonly<Record<string, CompiledMotionFeatures>>
    livaPresenceBoundary?: typeof LivaPresenceBoundary
    livaPresenceBindings?: typeof PresenceBindings
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
  readonly runtime: MotionRuntime
  readonly inspection: RuntimeInspection
  readonly definition: Definition

  /** Reads current viewport geometry; returns undefined after this registration unmounts. */
  bounds(): InstanceBounds | undefined
}

interface RootBinding {
  readonly root: HTMLElement
  readonly runtime: MotionRuntime
  readonly executor: BrowserExecutor
  readonly definition: Definition
  readonly releaseLayout: () => void
  readonly observed?: Omit<InstanceBinding, 'label'> & { label: string }
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

// Only compiler-generated bindings use this modifier; authored parameter objects
// remain opaque, even when they contain value, owner, or entries properties.
function motionValue(binding: DirectiveBinding): MotionValue {
  const value = binding.value
  return binding.modifiers.compiled ? value?.value : value
}

interface PluginOptions extends LivaOptions {
  readonly defaults?: CompiledMotionFeatures & {
    readonly presenceBindings?: typeof PresenceBindings
  }
  /** The named full plugin exposes replacement with any valid definition. */
  readonly Runtime?: typeof Runtime
  readonly inspect?: (
    runtime: MotionRuntime,
    executor: BrowserExecutor,
    report: (diagnostic: RuntimeDiagnostic) => void,
  ) => RuntimeInspection
  /** Preview uses its own candidate capabilities, while shipped Motion updates use compiled features. */
  readonly preview?: Pick<NonNullable<MotionFeatures['executor']>, 'preview' | 'controllers'>
}

/** Vue integration for compiled definitions, with optional development instruments. */
export function createCompiledLivaPlugin(options: PluginOptions = {}): Plugin {
  return {
    install(app: App) {
      let disposed = false
      // Vue can still deliver already-queued directive hooks after a callback
      // unmounts the application. Those hooks must not reacquire browser owners.
      const whileActive =
        <Args extends unknown[]>(action: (...args: Args) => void) =>
        (...args: Args) => {
          if (!disposed) action(...args)
        }
      const roots = new Map<HTMLElement, RootBinding>()
      const owners = new WeakMap<HTMLElement, object>()
      const targets = new Map<HTMLElement, { name: string; owner: object }>()
      const report = options.onDiagnostic ?? console.warn
      let presence: PresenceBindings<RootBinding> | undefined
      let layout: ReturnType<typeof createLayoutSession> | undefined

      const beforeMutation = whileActive(() => layout?.beforeMutation())
      const beforeRemoval = whileActive(() => layout?.beforeRemoval())

      app.mixin({
        beforeMount: beforeMutation,
        beforeUpdate: beforeMutation,
        beforeUnmount: beforeMutation,
      })
      app.onUnmount(() => {
        disposed = true
        layout?.dispose()
      })
      let scheduled = false

      const reconcileNow = whileActive(() => {
        const bindings = new Map<RootBinding, [string, HTMLElement][]>()

        for (const root of roots.values()) {
          bindings.set(root, [])
        }

        for (const [element, target] of targets) {
          let root = presence?.rootFor(element)

          if (!presence?.hasTarget(element)) {
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
      })

      const reconcile = () => {
        if (scheduled) return
        scheduled = true

        queueMicrotask(() => {
          scheduled = false
          reconcileNow()
        })
      }

      const presenceFor = (binding: DirectiveBinding) => {
        if (!binding.modifiers.compiled) return undefined

        const component: ComponentCustomOptions | undefined = binding.instance?.$options
        const Implementation = component?.livaPresenceBindings ?? options.defaults?.presenceBindings

        // Vue creates child directives before their parent root's created hook.
        if (Implementation && !presence)
          presence = new Implementation(roots, reconcileNow, beforeRemoval)

        return presence
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
          const features = options.Runtime
            ? options.defaults
            : (component.livaFeatures?.[definition.name] ?? options.defaults)

          if (features?.layoutSession && !layout) {
            layout = features.layoutSession(reconcileNow, report)
            layout.beforeMutation()
          }

          const executor = new BrowserExecutor(report, {
            ...features?.executor,
            ...options.preview,
          })
          let runtime: MotionRuntime | undefined

          try {
            const inputs = value === undefined ? {} : value
            runtime = options.Runtime
              ? new options.Runtime(executor, definition, inputs, report)
              : new MotionRuntime(executor, definition, inputs, report, features)
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
          runtime.onEvent = whileActive((name: string) =>
            element.dispatchEvent(new CustomEvent(`liva-${name}`, { bubbles: true })),
          )
          const inspection = options.inspect?.(runtime, executor, report)
          const observed = inspection && {
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
            releaseLayout: features?.layoutSession && layout ? layout.register(executor) : () => {},
          }
          if (observed) runtime.onUpdate = whileActive(() => options.observe?.('update', observed))
          roots.set(element, record)
          owners.set(element, binding.instance!)

          presenceFor(binding)?.registerRoot(element, binding.instance!, binding.value.owner)

          reconcile()
        } catch (error) {
          report({ code: 'vue.initialization', message: String(error), error })
        }
      }

      const unmount = (element: HTMLElement) => {
        const record = roots.get(element)

        if (!record) return

        // Capture while the old binding can still resolve its receivers. Capture
        // failures cannot skip another target, registration invalidation, or any
        // independent browser/runtime owner. Invalidate before release callbacks
        // so reentrant teardown cannot dispose/notify this registration twice.
        releaseResources([
          ...(presence?.departingTargets(record) ?? []),
          () => {
            roots.delete(element)
            owners.delete(element)
            presence?.removeRoot(element)
          },
          () => {
            try {
              record.releaseLayout()
            } catch (error) {
              report({ code: 'vue.layout-disposal', message: String(error), error })
            }
          },
          () => {
            try {
              record.runtime.dispose()
            } catch (error) {
              report({ code: 'vue.disposal', message: String(error), error })
            }
          },
          () => {
            if (record.observed) options.observe?.('unmount', record.observed)
          },
          reconcile,
        ])
      }

      const observeMount = (element: HTMLElement) => {
        const record = roots.get(element)
        if (!record?.observed) return

        // Vue has now populated attributes/children from its created-hook setup.
        record.observed.label =
          element.getAttribute('aria-label') ??
          `${record.definition.name} ${element.textContent.trim().slice(0, 30)}`
        options.observe?.('mount', record.observed)
      }

      const rootDirective: ObjectDirective<HTMLElement, MotionValue | PresenceBinding> = {
        created: whileActive(
          (element: HTMLElement, binding: DirectiveBinding<MotionValue | PresenceBinding>) => {
            mount(element, binding)
            presenceFor(binding)?.registerTarget(element, binding, ROOT_TARGET)
          },
        ),
        mounted: whileActive(observeMount),
        updated: whileActive(
          (element: HTMLElement, binding: DirectiveBinding<MotionValue | PresenceBinding>) => {
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
        ),
        beforeUnmount(element) {
          releaseResources([
            () => presence?.snapshotTarget(element),
            () => {
              presence?.removeTarget(element)
            },
            () => unmount(element),
          ])
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

      app.directive('liva', rootDirective)
      app.directive('liva-target', {
        created: whileActive(
          (element: HTMLElement, binding: DirectiveBinding<MotionValue | PresenceBinding>) => {
            bindTarget(element, binding)
            presenceFor(binding)?.registerTarget(element, binding)
          },
        ),
        updated: whileActive(bindTarget),
        beforeUnmount(element: HTMLElement) {
          releaseResources([
            () => presence?.snapshotTarget(element),
            () => {
              presence?.removeTarget(element)
              targets.delete(element)
            },
            reconcile,
          ])
        },
      })
    },
  }
}
