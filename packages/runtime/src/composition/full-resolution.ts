import {
  resolveComposition as composition,
  resolveLayers as layers,
  resolveLayerTracks as tracks,
} from './layers.ts'
import { resolveSelectedLayout, resolveLayoutConfigurations as persistentLayout } from './layout.ts'
import { builtinValues } from '../evaluation/full-expression.ts'

/** Resolves standalone compositions with the full standard evaluation environment. */
export function resolveComposition(
  ...[definition, values, selected, from, transitions]: Parameters<typeof composition>
) {
  return composition(
    definition,
    builtinValues(values),
    selected,
    from,
    transitions,
    resolveSelectedLayout,
  )
}

/** Applies live selection and layout to caller-supplied values. */
export function resolveLayers(
  ...[definition, values, previous, advance, event]: Parameters<typeof layers>
) {
  return layers(definition, builtinValues(values), previous, advance, event, resolveSelectedLayout)
}

/** Resolves directional tracks for a standalone composition. */
export function resolveLayerTracks(
  ...[previous, next, values, ...options]: Parameters<typeof tracks>
) {
  return tracks(previous, next, builtinValues(values), ...options)
}

/** Resolves persistent layout for standalone callers with the standard evaluation environment. */
export function resolveLayoutConfigurations(
  ...[definition, values, selected, transitions]: Parameters<typeof persistentLayout>
) {
  return persistentLayout(definition, builtinValues(values), selected, transitions)
}
