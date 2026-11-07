import {
  compositionLayerSelection,
  compositionTransitions,
  resolveLayerCascade,
  transitionPropertySources,
  type Composition,
  type CompositionTransition,
  type PropertySource,
  type TimingSource,
} from '@liva/runtime'
import type { Inspection } from './communication/protocol.ts'

export interface DeclarationSource {
  path: string
  text: string
  label: string
}

export interface TrackProvenance {
  fromDeclarationPath?: string
  toDeclarationPath?: string
  frameDeclarationPath?: string
  transition?: { from: string; to: string }
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

function scopePath(motion: string, source: TimingSource | PropertySource) {
  let path = `${motion}/layer/${source.layer.name}`

  if (source.state) path += `/state/${source.state.name}`
  if (source.target) path += `/target/${source.target.name}`
  if (source.property) path += `/property/${source.property.name}`

  return path
}

function valuePath(motion: string, source: PropertySource) {
  return `${scopePath(motion, source)}${source.property.keyframes ? '/frame/1/value' : '/value'}`
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
  const sources = (composition: Composition) =>
    resolveLayerCascade(
      compositionLayerSelection(definition, composition),
      (source) => source,
      (source) => source,
    )
      .find((item) => item.name === target)
      ?.properties.find((item) => item.name === property)
  const before = sources(from)
  const after = sources(to)
  const owner = after?.source
  const fromSource = before?.source
  const transitions = compositionTransitions(definition, to, from, selected ? [selected] : [])
  const transition = owner ? transitions.get(owner.layer.name) : undefined
  const effectiveTransition = transition?.transition
  const transitionPath =
    selected && effectiveTransition
      ? `${definition.name}/layer/${selected.layer}/transition/${selected.index}`
      : undefined
  let timingSource = after?.timing
    ? field(fields, `${scopePath(definition.name, after.timing)}/timing`)
    : undefined

  if (transitionPath) {
    const transitionSources = transitionPropertySources(effectiveTransition, target, property)

    if (transitionSources.timing) {
      const suffix =
        transitionSources.timing === transitionSources.property
          ? `/target/${target}/property/${property}`
          : transitionSources.timing === transitionSources.target
            ? `/target/${target}`
            : ''
      timingSource = field(fields, `${transitionPath}${suffix}/timing`)
    }
  }

  const mapped = (path: string | undefined) =>
    fields.some((item) => item.path === path && item.kind === 'block')
  const availableTransition = mapped(transitionPath) ? transitionPath : undefined
  const declaredStylePath = owner ? scopePath(definition.name, owner) : undefined
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
    fromDeclarationPath: fromSource ? valuePath(definition.name, fromSource) : undefined,
    toDeclarationPath: owner ? valuePath(definition.name, owner) : undefined,
    frameDeclarationPath: transitionPath ?? declaredStylePath,
    transition,
    from: fromSource ? field(fields, valuePath(definition.name, fromSource)) : undefined,
    to: owner ? field(fields, valuePath(definition.name, owner)) : undefined,
    sharedValue:
      !!fromSource &&
      !!owner &&
      valuePath(definition.name, fromSource) === valuePath(definition.name, owner),
    owner: owner?.layer.name ?? 'External CSS',
    overridden: (after?.declarations.slice(0, -1) ?? []).flatMap((item) => {
      const source = field(fields, valuePath(definition.name, item))
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
