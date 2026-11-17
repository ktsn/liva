import { assembleRuntime, type RuntimeAssembly } from './assembly.ts'
import { layerTargets } from '../../composition/layers.ts'
import type { Definition } from '../../model/definition.ts'
import type { RuntimeDiagnostic } from '../../execution/execution-contracts.ts'

/** Owns mounted runtimes and DOM elements for a browser test suite. */
export function createBrowserRuntimeHarness() {
  const assemblies: RuntimeAssembly[] = []
  const elements: HTMLElement[] = []

  function append(element: HTMLElement) {
    document.body.append(element)
    elements.push(element)
  }

  function trackAssembly(assembly: RuntimeAssembly) {
    assemblies.push(assembly)
  }

  function setup(definition: Definition, inputs: Record<string, unknown> = {}) {
    const errors: RuntimeDiagnostic[] = []
    const assembly = assembleRuntime(definition, inputs, (error) => errors.push(error))

    trackAssembly(assembly)

    const targets = new Map(
      layerTargets(definition).map(({ name }) => {
        const element = document.createElement('div')

        append(element)

        return [name, element] as const
      }),
    )

    assembly.executor.bind([...targets])

    return { assembly, targets, errors }
  }

  function dispose() {
    for (const assembly of assemblies.splice(0)) assembly.runtime.dispose()

    for (const element of elements.splice(0)) element.remove()
  }

  return { setup, append, trackAssembly, dispose }
}
