import type {
  Composition,
  CompositionTransition,
  Definition,
  Layer,
  Property,
  Target,
} from '@liva/runtime'
import type { Inspection } from './communication/protocol.ts'

export interface DeclarationSource {
  path: string
  text: string
  label: string
}

export interface TrackProvenance {
  from?: DeclarationSource
  to?: DeclarationSource
  sharedValue: boolean
  owner: string
  overridden: DeclarationSource[]
  timingSource?: DeclarationSource
  timingDestination?: string
  timingUnavailable?: string
  frameDestination?: string
  framesUnavailable?: string
  localTiming?: DeclarationSource
  fields: Inspection['fields']
}

function field(fields: Inspection['fields'], path: string): DeclarationSource | undefined {
  const found = fields.find((item) => item.path === path && item.kind === 'value')

  return found ? { path, text: found.value, label: path } : undefined
}

function propertyAt(targets: readonly Target<Property>[], target: string, property: string) {
  return targets
    .find((item) => item.name === target)
    ?.properties.find((item) => item.name === property)
}

function activeLayers(definition: Definition, composition: Composition) {
  return (definition.layers ?? []).filter(
    (layer) => layer.states?.length || composition.layers[layer.name],
  )
}

function valueDeclarations(
  definition: Definition,
  composition: Composition,
  target: string,
  property: string,
) {
  const result: { layer: Layer; path: string }[] = []

  for (const layer of activeLayers(definition, composition)) {
    const path = `${definition.name}/layer/${layer.name}`
    const state = layer.states?.find((item) => item.name === composition.states[layer.name])

    for (const [scope, targets] of [
      [path, layer.targets],
      [`${path}/state/${state?.name}`, state?.targets ?? []],
    ] as const) {
      const declaration = propertyAt(targets, target, property)

      if (declaration) {
        const suffix = declaration.keyframes ? '/frame/1/value' : '/value'
        result.push({ layer, path: `${scope}/target/${target}/property/${property}${suffix}` })
      }
    }
  }

  return result
}

export function trackProvenance(
  inspection: Inspection,
  from: Composition,
  to: Composition,
  selected: CompositionTransition | undefined,
  target: string,
  property: string,
): TrackProvenance {
  const { definition, fields } = inspection
  const before = valueDeclarations(definition, from, target, property)
  const after = valueDeclarations(definition, to, target, property)
  const owner = after.at(-1)
  const fromSource = before.at(-1)
  let timingSource: DeclarationSource | undefined

  for (const layer of activeLayers(definition, to)) {
    const path = `${definition.name}/layer/${layer.name}`
    const state = layer.states?.find((item) => item.name === to.states[layer.name])

    if (
      !propertyAt(layer.targets, target, property) &&
      !propertyAt(state?.targets ?? [], target, property)
    )
      continue

    for (const scope of [path, ...(state ? [`${path}/state/${state.name}`] : [])]) {
      for (const candidate of [
        scope,
        `${scope}/target/${target}`,
        `${scope}/target/${target}/property/${property}`,
      ]) {
        timingSource = field(fields, `${candidate}/timing`) ?? timingSource
      }
    }
  }

  const effectiveTransition =
    selected && owner?.layer.name === selected.layer
      ? owner.layer.transitions?.[selected.index]
      : undefined
  const transitionPath =
    selected && effectiveTransition
      ? `${definition.name}/layer/${selected.layer}/transition/${selected.index}`
      : undefined

  if (transitionPath) {
    for (const candidate of [
      transitionPath,
      `${transitionPath}/target/${target}`,
      `${transitionPath}/target/${target}/property/${property}`,
    ]) {
      timingSource = field(fields, `${candidate}/timing`) ?? timingSource
    }
  }

  const mapped = (path: string | undefined) =>
    fields.some((item) => item.path === path && item.kind === 'block')
  const availableTransition = mapped(transitionPath) ? transitionPath : undefined
  const declaredStylePath = owner?.path.replace(/\/frame\/1\/value$|\/value$/, '')
  const stylePath = mapped(declaredStylePath) ? declaredStylePath : undefined
  const timingDestination = availableTransition
    ? `${availableTransition}/target/${target}/property/${property}`
    : stylePath
  const localTiming = timingDestination ? field(fields, `${timingDestination}/timing`) : undefined
  const stateMasksCommon =
    !availableTransition &&
    owner?.layer.states?.length &&
    stylePath &&
    !stylePath.includes('/state/') &&
    timingSource?.path.includes('/state/')
  const frameDestination = availableTransition
    ? `${availableTransition}/target/${target}/property/${property}`
    : owner?.layer.states?.length
      ? undefined
      : stylePath

  return {
    from: fromSource ? field(fields, fromSource.path) : undefined,
    to: owner ? field(fields, owner.path) : undefined,
    sharedValue: !!fromSource && fromSource.path === owner?.path,
    owner: owner?.layer.name ?? 'External CSS',
    overridden: after.slice(0, -1).flatMap((item) => {
      const source = field(fields, item.path)
      return source ? [source] : []
    }),
    timingSource,
    timingDestination: stateMasksCommon ? undefined : timingDestination,
    timingUnavailable: stateMasksCommon
      ? 'Destination-state timing overrides this common declaration. Select an existing transition to create an effective local override.'
      : undefined,
    frameDestination,
    framesUnavailable: !frameDestination
      ? 'Select an existing transition in the animation owner to edit keyframes. State style tracks are not chosen automatically.'
      : undefined,
    localTiming,
    fields,
  }
}

export function typedEasingText(css: string): string {
  const names: Record<string, string> = {
    linear: 'linear',
    ease: 'ease',
    'ease-in': 'easeIn',
    'ease-out': 'easeOut',
    'ease-in-out': 'easeInOut',
    'step-start': 'stepStart',
    'step-end': 'stepEnd',
  }

  if (Object.hasOwn(names, css)) return names[css]

  const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(css)

  if (bezier) {
    const values = bezier[1].split(',').map((value) => value.trim())
    return `cubicBezier(${['x1', 'y1', 'x2', 'y2'].map((name, index) => `${name}: ${values[index]}`).join(', ')})`
  }

  const steps = /^steps\((\d+),\s*([\w-]+)\)$/.exec(css)

  if (steps) return `steps(count: ${steps[1]}, position: "${steps[2]}")`

  throw new Error('This easing has no typed representation. Edit the timing expression directly.')
}

export function typedTimingText(timing: import('@liva/runtime').Timing): string {
  if (timing.kind === 'tween')
    return `tween(duration: ${timing.durationMs}, easing: ${typedEasingText(timing.easing)})`
  if (timing.kind === 'spring-duration')
    return `spring(duration: ${timing.durationMs}, bounce: ${timing.bounce})`

  return `spring(stiffness: ${timing.stiffness}, damping: ${timing.damping}, mass: ${timing.mass})`
}
