import {
  compositionLayerSelection,
  resolveDeclarationCascade,
  transitionPropertySources,
  type DeclarationSource,
  type LayerSelection,
  type TimingSource,
} from './layer-cascade.ts'
import type { Composition } from './layers.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import {
  isCssProperty,
  type Declaration,
  type Definition,
  type GuardedTransition,
  type Target,
} from '../model/definition.ts'
import type {
  LayoutDeclaration,
  LayoutDeclarationSource,
  LayoutTimingSource,
  ResolvedLayoutConfiguration,
} from '../model/layout.ts'

function isLayoutDeclaration(declaration: Declaration): declaration is LayoutDeclaration {
  return !isCssProperty(declaration)
}

function targetHasLayout(target: Target<Declaration>): boolean {
  return target.properties.some(isLayoutDeclaration)
}

function sourceIdentity(source: DeclarationSource<LayoutDeclaration>): LayoutDeclarationSource {
  return {
    layer: source.layer.name,
    state: source.state?.name,
    target: source.target.name,
    declaration: source.property,
  }
}

function resolveTiming(source: TimingSource, values: VariableValues) {
  const { declaration } = source

  return declaration.timingExpression
    ? timingValue(evaluate(declaration.timingExpression, values))
    : declaration.timing
}

/**
 * Resolves layout at a geometry-change boundary from accepted inputs and selection.
 * This does not advance guards/state machines, read elements, or create CSS tracks.
 * Later declarations replace the entire selection; timing inherits independently.
 * Pass selected directional transitions only for the transaction that selected them;
 * the default resolves persistent declaration timing for unrelated geometry changes.
 * It never replays a previous state transition or changes state/event history.
 * Composition/transitions must be accepted selections from resolveLayers or
 * resolveComposition. Invalid timing expressions and unknown states throw.
 */
export function resolveLayoutConfigurations(
  definition: Definition,
  values: VariableValues,
  composition: Composition,
  transitions: ReadonlyMap<string, GuardedTransition> = new Map(),
): readonly ResolvedLayoutConfiguration[] {
  return resolveSelectedLayout(
    [...compositionLayerSelection(definition, composition)],
    values,
    transitions,
  )
}

/** Shared internal entry when live resolution already selected layers and states. */
export function resolveSelectedLayout(
  selection: readonly LayerSelection[],
  values: VariableValues,
  transitions: ReadonlyMap<string, GuardedTransition>,
): readonly ResolvedLayoutConfiguration[] {
  // Ordinary CSS-only updates need no layout ownership/provenance calculation.
  // Test declarations rather than enabled axes: an explicit none still has provenance.
  if (
    !selection.some(
      ({ layer, state }) =>
        layer.targets.some(targetHasLayout) || state?.targets.some(targetHasLayout),
    )
  )
    return []

  const ownership = resolveDeclarationCascade(
    isCssProperty,
    selection,
    () => true,
    () => undefined,
  )
  const transformTargets = new Set(
    ownership
      .filter((target) => target.properties.some((property) => property.name === 'transform'))
      .map((target) => target.name),
  )
  const layouts = resolveDeclarationCascade(
    isLayoutDeclaration,
    selection,
    ({ property }) => property.axes,
    (source) => ({ timing: resolveTiming(source, values), source }),
  )

  return layouts.flatMap((target) =>
    target.properties.map((property) => {
      const directional = transitions.get(property.source.layer.name)
      const override = transitionPropertySources(directional?.transition, target.name, '$layout')
      const provider = override.timing
      const timing = provider
        ? provider.timingExpression
          ? timingValue(evaluate(provider.timingExpression, values))
          : provider.timing
        : property.timing?.timing

      const inherited = property.timing?.source
      const timingSource: LayoutTimingSource | undefined =
        provider && directional
          ? {
              layer: property.source.layer.name,
              transition: property.source.layer.transitions?.indexOf(directional),
              target: provider === directional.transition ? undefined : override.target?.name,
              property: provider === override.property ? '$layout' : undefined,
            }
          : inherited
            ? {
                layer: inherited.layer.name,
                state: inherited.state?.name,
                target: inherited.target?.name,
                property: inherited.property?.name,
              }
            : undefined

      return {
        target: target.name,
        axes: property.value,
        timing,
        timingSource,
        source: sourceIdentity(property.source),
        declarations: property.declarations.map(sourceIdentity),
        explicitTransform: transformTargets.has(target.name),
      }
    }),
  )
}
