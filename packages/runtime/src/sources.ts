import type { Definition, MotionParameter, Source } from './definition.ts'
import { invokeSource, type RuntimeSource } from './builtins/index.ts'
import type { SourceValues } from './expression.ts'

export function targetValues(definition: Definition, previous: SourceValues = {}): SourceValues {
  const names = new Set(
    definition.states.flatMap((state) => state.targets.map((target) => target.name)),
  )

  return Object.fromEntries(
    [...names].map((name) => {
      const retained = Object.hasOwn(previous, name) ? previous[name] : undefined
      const value =
        typeof retained === 'object' && retained.name === name ? retained : Object.freeze({ name })

      return [name, value]
    }),
  )
}

export function createSources(
  sources: readonly Source[],
  values: SourceValues,
): ReadonlyMap<string, RuntimeSource> {
  return new Map(sources.map((source) => [source.name, invokeSource(source.initializer, values)]))
}

export function sourceValues(sources: ReadonlyMap<string, RuntimeSource>): SourceValues {
  return Object.fromEntries([...sources].map(([name, source]) => [name, source.value]))
}

export function parameterValues(
  parameters: readonly MotionParameter[],
  values: SourceValues,
  inputs: Readonly<Record<string, unknown>>,
): SourceValues {
  const next = { ...values }

  for (const name of Object.keys(inputs)) {
    if (!parameters.some((parameter) => parameter.name === name)) {
      throw new Error(`Unknown motion parameter: ${name}`)
    }
  }

  for (const parameter of parameters) {
    if (!Object.hasOwn(inputs, parameter.name)) {
      throw new Error(`Missing motion parameter: ${parameter.name}`)
    }

    const value = inputs[parameter.name]

    if (typeof value !== parameter.type || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`Motion parameter ${parameter.name} requires ${parameter.type}`)
    }

    Object.defineProperty(next, parameter.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return next
}
