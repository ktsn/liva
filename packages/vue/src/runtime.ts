import type { App, ComponentCustomOptions, DirectiveBinding, ObjectDirective, Plugin } from 'vue'
import { LivaInstance, type Definition, type RuntimeDiagnostic } from '@liva/runtime'

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

export function createLivaPlugin(options: LivaOptions = {}): Plugin {
  return {
    install(app: App) {
      const roots = new Map<HTMLElement, InstanceBinding>()
      const owners = new WeakMap<HTMLElement, object>()
      const targets = new Map<HTMLElement, { name: string; owner: object }>()
      const report = options.onDiagnostic ?? console.warn
      let scheduled = false

      const reconcile = () => {
        if (scheduled) return
        scheduled = true

        queueMicrotask(() => {
          scheduled = false
          const bindings = new Map<InstanceBinding, [string, HTMLElement][]>()
          for (const root of roots.values()) bindings.set(root, [])

          for (const [element, target] of targets) {
            let parent: HTMLElement | null = element

            while (parent && !roots.has(parent)) parent = parent.parentElement
            const root = parent ? roots.get(parent) : undefined

            if (root && owners.get(root.root) === target.owner) {
              bindings.get(root)!.push([target.name, element])
            }
          }

          for (const [root, entries] of bindings) root.runtime.bind(entries)
        })
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
          let requestedState = runtime.state
          const record = {
            root: element,
            component,
            runtime,
            definition,
            get requestedState() {
              return typeof binding.value === 'string' ? requestedState : runtime.sourceState
            },
            set requestedState(state: string) {
              requestedState = state
            },
          }
          runtime.onSourceState = (state) => {
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
          record.runtime.dispose()
          roots.delete(element)
          options.observe?.('unmount', record)
          reconcile()
        }
      }

      const rootDirective: ObjectDirective<HTMLElement, string | Record<string, unknown>> = {
        mounted: mount,
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

      app.directive('liva', rootDirective)
      app.directive('liva-target', {
        mounted: bindTarget,
        updated: bindTarget,
        beforeUnmount(element: HTMLElement) {
          targets.delete(element)
          reconcile()
        },
      })
    },
  }
}
