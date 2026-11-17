import type { PreviewOperation } from './preview-operation.ts'
import {
  resolveComposition,
  layerTrackTemplates,
  completeLayerTrack,
  type Composition,
  type CompositionTransition,
  type LayerResolution,
} from '../composition/layers.ts'
import { renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { InspectionExecutionPort, RuntimeDiagnostic } from './execution-contracts.ts'
import { Runtime } from './runtime.ts'
import { resolveControllerPresentation } from './controller-presentation.ts'
import { captureLifecycleDefinition, resolveLifecycleTracks } from './lifecycle.ts'
import {
  planTrackObservations,
  planTrack,
  trackTiming,
  planPreviewPresentation,
  presentationWrites,
  layerPropertyKey,
  type PresentationFacts,
  type ReceiverAddresses,
  type TrackPlan,
} from './presentation-planner.ts'

/**
 * Evaluates isolated candidate definitions and coordinates inspection/paused previews.
 * Runtime owns candidate calls; Executor owns all observations, styles and effects.
 * Inspection never accepts live inputs, advances state history, or emits events.
 */
export class RuntimeInspection {
  private readonly runtime: Runtime
  private readonly execution: InspectionExecutionPort
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(
    runtime: Runtime,
    execution: InspectionExecutionPort,
    report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
  ) {
    this.runtime = runtime
    this.execution = execution
    this.report = report
  }

  private resolveControllers(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition: Definition,
    live: boolean,
  ) {
    return resolveControllerPresentation(this.execution, definition, resolution, values, time, live)
  }

  /** Numeric/displayed observations are requested only after canonical ownership is known. */
  private planTracks(
    sources: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
    facts: PresentationFacts,
    fill: TrackPlan['fill'],
  ) {
    const timings = new Map(sources.map(({ source }) => [source, trackTiming(source)]))
    const candidates = this.execution.expandTracks(sources)
    const observations = planTrackObservations(candidates, facts.active, false)
    const snapshots = this.execution.observeTracks(observations.requests)
    const start: TrackPlan[] = []

    for (const snapshot of snapshots) {
      // The executor preserves each request's source and ownership facts. All requests
      // passed the ownership filter, so these plans cannot be omitted; timings are cached above.
      start.push(planTrack(snapshot, timings.get(snapshot.source)!, fill)!)
    }

    return { changed: observations.changed, start }
  }

  /** Captures lifecycle expressions against an explicit ordinary composition; candidate-only calls are released after validation. */
  inspectLifecycle(
    phase: 'enter' | 'leave',
    composition: Composition,
    definition = this.runtime.definition,
  ) {
    return this.runtime.evaluateCandidate(definition, (values) => ({
      presentation: this.resolveControllers(
        resolveComposition(definition, values, composition),
        values,
        performance.now(),
        definition,
        false,
      ).presentation,
      transition: captureLifecycleDefinition(definition, phase, values),
    }))
  }

  /** Resolves explicit layer/state selections and selected transitions without advancing live guards/history. Reports and rethrows invalid candidates. */
  inspectComposition(
    composition: Composition,
    from?: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.runtime.definition,
  ): LayerResolution {
    try {
      return this.runtime.evaluateCandidate(definition, (values) => {
        const resolution = this.resolveControllers(
          resolveComposition(definition, values, composition, from, transitions),
          values,
          performance.now(),
          definition,
          false,
        )

        return {
          ...resolution,
          transitions: new Map(
            [...resolution.transitions].flatMap(([name, transition]) => {
              const targets = transition.transition.targets.flatMap((target) => {
                const properties = target.properties.filter((property) =>
                  resolution.presentation.targets
                    .find((item) => item.name === target.name)
                    ?.properties.some((item) => item.name === property.name && item.owner === name),
                )

                return resolution.presentation.targets.some(
                  (item) =>
                    item.name === target.name &&
                    item.properties.some((property) => property.owner === name),
                )
                  ? [{ ...target, properties }]
                  : []
              })

              if (
                !resolution.presentation.targets.some((target) =>
                  target.properties.some((property) => property.owner === name),
                )
              )
                return []

              const rendered = renderTransition({ ...transition.transition, targets }, values)

              return [
                [
                  name,
                  {
                    ...transition,
                    transition: {
                      timing: rendered.timing,
                      targets: rendered.targets.map((target) => ({
                        name: target.name,
                        timingProperties: target.timingProperties,
                        timing: target.timing,
                        properties: target.properties.map((property) => ({
                          name: property.name,
                          timing: property.timing,
                          keyframes: property.keyframes?.map((frame) => ({
                            offset: frame.offset,
                            value: frame.value,
                            easing: frame.easing,
                          })),
                        })),
                      })),
                    },
                  },
                ] as const,
              ]
            }),
          ),
        }
      })
    } catch (error) {
      this.report({ code: 'runtime.inspection', message: String(error), error })
      throw error
    }
  }

  /**
   * Prepares a paused preview of explicit compositions/candidate IR through the common
   * planner. Supersedes prior preview effects; the returned handle owns only this
   * preview. Preparation failure restores application presentation, reports its
   * original cause, and throws. Requires a mounted, valid receiver registration.
   */
  previewComposition(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.runtime.definition,
    phase?: 'enter' | 'leave',
  ): PreviewOperation {
    if (this.runtime.isDisposed || this.execution.bindingFacts.suspended) {
      throw new Error('Composition preview requires a mounted layer instance')
    }

    try {
      const candidate = this.runtime.evaluateCandidate(definition, (values) => {
        const previous = this.resolveControllers(
          resolveComposition(definition, values, from),
          values,
          performance.now(),
          definition,
          false,
        )
        const next = this.resolveControllers(
          resolveComposition(definition, values, to, from, transitions),
          values,
          performance.now(),
          definition,
          false,
        )
        const lifecycle = phase ? captureLifecycleDefinition(definition, phase, values) : undefined
        return { values, previous, next, lifecycle }
      })
      const { values, previous, next, lifecycle } = candidate
      const facts = this.execution.presentationFacts()
      this.execution.beginPreview(presentationWrites(previous, facts.receivers))

      const templates = new Map(
        facts.receivers.map((receiver) => {
          const targetResolution = {
            ...next,
            presentation: {
              ...next.presentation,
              targets: next.presentation.targets.filter(
                (target) => target.name === receiver.target,
              ),
            },
          }
          const tracks = phase
            ? []
            : [
                ...layerTrackTemplates(
                  previous,
                  targetResolution,
                  values,
                  (message) => this.report({ code: 'runtime.endpoint', message }),
                  () => true,
                ),
              ]

          return [receiver.target, tracks] as const
        }),
      )
      const requests = facts.receivers.flatMap((receiver) => {
        const properties = phase
          ? (lifecycle?.targets
              .filter((target) => target.name === receiver.target)
              .flatMap((target) => target.properties.map((property) => property.name)) ?? [])
          : // Every logical target was assigned its templates above.
            templates
              .get(receiver.target)!
              .filter((track) => track.implicitStart)
              .map((track) => track.property)

        return properties.map((property) => ({ receiver: receiver.id, property }))
      })
      const displayed = new Map(
        this.execution
          .observeDisplayed(requests)
          .map((value) => [layerPropertyKey(String(value.receiver), value.property), value.value]),
      )
      const sources = facts.receivers.flatMap((receiver) => {
        const read = (property: string) =>
          displayed.get(layerPropertyKey(String(receiver.id), property))
        const tracks = phase
          ? resolveLifecycleTracks(phase, lifecycle, next.presentation, (target, property) =>
              target === receiver.target ? read(property) : undefined,
            )
          : // Explicit starts need no displayed value; every implicit start was requested above.
            templates
              .get(receiver.target)!
              .map((template) =>
                completeLayerTrack(
                  template,
                  template.implicitStart ? read(template.property)! : '',
                ),
              )

        return tracks.map((source) => ({
          receiver: receiver.id,
          source: phase ? { ...source, implicitStart: false } : source,
        }))
      })
      // Lifecycle declarations have their own ownership. Ordinary previews share the application cascade.
      const addresses = phase
        ? []
        : this.execution.observeReceivers(
            next,
            new Set(sources.map(({ source }) => source.target)),
            false,
          )
      const tracks = this.planTracks(
        sources.map((source) => ({
          ...source,
          declarations: addresses.find(
            (receiver) =>
              receiver.id === source.receiver && receiver.target === source.source.target,
          )?.addresses,
        })),
        facts,
        phase === 'leave' ? 'both' : 'backwards',
      )
      this.execution.applyPlan(planPreviewPresentation(next, facts.receivers, tracks.start))

      return this.execution.completePreview()
    } catch (cause) {
      try {
        this.execution.abortPreview()
      } catch (error) {
        this.report({ code: 'runtime.preview-cleanup', message: String(error), error })
      }
      const error = new Error('Could not prepare composition preview', { cause })
      this.report({ code: 'runtime.preview', message: error.message, error })

      throw error
    }
  }

  /** Previews enter/leave against an ordinary baseline without joining Vue presence completion or changing live state. */
  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.runtime.composition,
    definition = this.runtime.definition,
  ): PreviewOperation {
    return this.previewComposition(composition, composition, [], definition, phase)
  }
}
