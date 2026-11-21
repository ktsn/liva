import type {
  CssValue,
  Declaration,
  Definition,
  Expression,
  Frame,
  Target,
  Timing,
  Transition,
} from '@liva/runtime'

import { hasLifecycle } from '@liva/runtime/features/execution/lifecycle'
import { definitionTargetNames } from '@liva/runtime/features/model/targets'
import { allPureBuiltins } from '@liva/runtime/features/evaluation/all-builtins'
import { allReactiveBuiltins } from '@liva/runtime/features/builtins/index'

const constants = new Set(Object.keys(allPureBuiltins.constants))
const timings = new Set(Object.keys(allPureBuiltins.functions))
const reactive = new Set(Object.keys(allReactiveBuiltins))

interface Features {
  readonly constants: Set<string>
  readonly timings: Set<string>
  readonly reactive: Set<string>
  spring: boolean
  layout: boolean
  controllers: boolean
  presence: boolean
}

/** Collects capabilities for every reachable or inactive declaration of one validated Motion. */
export function motionFeatures(definition: Definition): Features {
  const features: Features = {
    constants: new Set(),
    timings: new Set(),
    reactive: new Set(),
    spring: false,
    layout: false,
    controllers: false,
    presence: hasLifecycle(definition),
  }

  const scope = new Set([
    ...definitionTargetNames(definition),
    ...(definition.parameters ?? []).map(({ name }) => name),
    ...(definition.letBindings ?? []).map(({ name }) => name),
  ])

  const expression = (node?: Expression) => {
    if (!node) return

    switch (node.kind) {
      case 'reference': {
        const [name] = node.path

        if (!scope.has(name) && constants.has(name)) features.constants.add(name)

        break
      }
      case 'call': {
        const name = node.function

        // The compiler rejects calls to parameters, targets and let values.
        if (timings.has(name)) features.timings.add(name)
        if (reactive.has(name)) features.reactive.add(name)
        if (name === 'spring') features.spring = true

        for (const argument of node.arguments) expression(argument.value)

        break
      }
      case 'binary':
        expression(node.left)
        expression(node.right)
        break
      case 'unary':
        expression(node.operand)
        break
    }
  }

  const timing = (provider: { timing?: Timing; timingExpression?: Expression }) => {
    if (provider.timing && provider.timing.kind !== 'tween') features.spring = true

    expression(provider.timingExpression)
  }

  const css = (value: CssValue) => {
    if (value.kind === 'template') {
      for (const part of value.parts) {
        if (typeof part !== 'string') expression(part)
      }
    }
  }

  const frame = (item: Frame) => {
    expression(item.easingExpression)
    css(item.value)
  }

  const transition = (item?: Transition) => {
    if (!item) return

    timing(item)

    for (const target of item.targets) {
      timing(target)

      for (const property of target.properties) {
        if (property.name === '$layout') features.layout = true

        timing(property)

        for (const value of property.keyframes ?? []) frame(value)
      }
    }
  }

  const declarations = (targets: readonly Target<Declaration>[]) => {
    for (const target of targets) {
      timing(target)

      for (const property of target.properties) {
        timing(property)

        if ('kind' in property) {
          features.layout = true
          continue
        }

        const value = property.value

        switch (value.kind) {
          case 'binding':
            features.controllers = true
            expression(value.expression)
            break
          case 'keyframes':
            for (const item of value.frames) frame(item)
            break
          default:
            css(value)
        }
      }
    }
  }

  for (const binding of definition.letBindings ?? []) expression(binding.initializer)

  for (const event of definition.events ?? []) expression(event.when)

  for (const layer of definition.layers) {
    timing(layer)
    expression(layer.when)
    declarations(layer.targets)

    for (const state of layer.states ?? []) {
      timing(state)
      declarations(state.targets)
    }

    for (const guarded of layer.transitions ?? []) {
      expression(guarded.event)
      expression(guarded.when)
      transition(guarded.transition)
    }
  }

  transition(definition.enter)
  transition(definition.leave)

  return features
}

const literal = (names: Set<string>) => `{ ${[...names].join(', ')} }`

/** Emits the block's union of static imports and one implementation object per Motion. */
export function emitFeatures(definitions: readonly Definition[]) {
  const imports = new Map<string, Set<string>>()
  const use = (path: string, ...names: string[]) => {
    let imported = imports.get(path)

    if (!imported) {
      imported = new Set()
      imports.set(path, imported)
    }

    for (const name of names) imported.add(name)
  }

  const motions = definitions.map((definition) => {
    const features = motionFeatures(definition)
    const config: string[] = []
    const executor: string[] = []
    const pure: string[] = []

    if (features.constants.size) {
      use('liva:runtime/evaluation/constants', ...features.constants)
      pure.push(`constants: ${literal(features.constants)}`)
    }

    if (features.timings.size) {
      use('liva:runtime/evaluation/timing-builtins', ...features.timings)
      pure.push(`functions: ${literal(features.timings)}`)
    }

    if (pure.length) config.push(`pure: { ${pure.join(', ')} }`)

    if (features.reactive.size) {
      use('liva:runtime/evaluation/reactive-call-store', 'ReactiveCallStore')
      use('liva:runtime/execution/sources-execution', 'SourcesExecution')

      for (const name of features.reactive) use(`liva:runtime/builtins/${name}`, name)

      config.push(`reactive: { Store: ReactiveCallStore, builtins: ${literal(features.reactive)} }`)
      executor.push('sources: SourcesExecution')
    }

    if (features.spring) {
      use('liva:runtime/motion/spring-playback', 'springPlayback')
      executor.push('spring: springPlayback')
    }

    if (features.controllers) {
      use('liva:runtime/execution/controller-feature', 'controllerFeature', 'ControllersExecution')
      config.push('controllers: controllerFeature')
      executor.push('controllers: ControllersExecution')
    }

    if (features.layout) {
      use('liva:runtime/execution/layout-feature', 'layoutFeature', 'LayoutExecution')
      use('liva:vue/layout', 'createLayoutSession')
      config.push('layout: layoutFeature', 'layoutSession: createLayoutSession')
      executor.push('layout: LayoutExecution')
    }

    if (features.presence) {
      use('liva:runtime/execution/presence-execution', 'PresenceExecution')
      use('liva:vue/presence', 'LivaPresenceBoundary')
      use('liva:vue/presence-bindings', 'PresenceBindings')
      executor.push('presence: PresenceExecution')
    }

    if (executor.length) config.push(`executor: { ${executor.join(', ')} }`)

    return `[${JSON.stringify(definition.name)}]: { ${config.join(', ')} }`
  })

  return {
    imports: [...imports]
      .map(([path, names]) => `import { ${[...names].join(', ')} } from ${JSON.stringify(path)};`)
      .join('\n'),
    motions: `{ ${motions.join(', ')} }`,
    presence: imports.has('liva:vue/presence'),
  }
}
