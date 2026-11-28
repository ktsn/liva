import { InlineStyleHistory } from './inline-style-history.ts'
import { isLayoutStyleProperty } from '../layout/style-properties.ts'
import { observeLayoutStyles } from '../layout/style-observation.ts'
import type { ActiveTrack } from './browser-executor.ts'
import { LayoutStyleBaseline } from './layout-style-baseline.ts'
import {
  ownLayoutStyleSource,
  layoutStyleSourceTimes,
  layoutStyleSourceRevision,
  type LayoutStyleObservation,
  type LayoutStyleProjection,
} from '../layout/style-observation.ts'
import type { LayoutBoxConstraints } from '../layout/layout-constraints.ts'
import { batchLayoutWrites } from '../layout/layout-write-phase.ts'
import { waapiProperty } from '../motion/animation.ts'
import { resolveLayoutConfigurations } from '../composition/layout.ts'
import type { LayoutCandidate } from '../layout/layout-participant.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'
import { declarationTargets } from '../composition/layers.ts'
import { writeLayoutStyle } from '../layout/layout-scheduler.ts'
import type { BrowserExecutor } from './browser-executor.ts'
import { restoredStyle, writeOwnedStyle, type OwnedElement } from './style-ownership.ts'

export class LayoutExecution {
  private readonly host: Pick<
    BrowserExecutor,
    | 'disposed'
    | 'definition'
    | 'values'
    | 'layerResolution'
    | 'targetReceivers'
    | 'lifecycleOwns'
    | 'active'
    | 'suspended'
    | 'presentationMode'
    | 'motion'
    | 'spring'
    | 'onLayoutChange'
  >

  constructor(
    host: Pick<
      BrowserExecutor,
      | 'disposed'
      | 'definition'
      | 'values'
      | 'layerResolution'
      | 'targetReceivers'
      | 'lifecycleOwns'
      | 'active'
      | 'suspended'
      | 'presentationMode'
      | 'motion'
      | 'spring'
      | 'onLayoutChange'
    >,
  ) {
    this.host = host
  }

  advanceRevision() {
    this.layoutGeneration++
  }

  acceptedPresentation() {
    this.advanceRevision()
    this.host.onLayoutChange?.()
  }

  presentationChanged() {
    // Physical aliases, preview and retained Presence can suppress projection.
    for (const candidate of this.layoutCandidates()) {
      if (candidate.blocked) this.layoutTransform(candidate.element, undefined)
    }

    this.host.onLayoutChange?.()
  }

  private write(element: HTMLElement, property: string, value: string) {
    writeOwnedStyle(this.layoutOwned, element, property, value, 'important', {
      history: (owner) => new InlineStyleHistory(element, owner.written),
      mutate: (action) => writeLayoutStyle(element, action),
      reorder: property !== 'transform',
    })
  }

  writeOrdinary(element: HTMLElement, property: string, write: () => void) {
    const projection = this.layoutEffects.get(element)?.styles

    if (projection && isLayoutStyleProperty(property)) {
      observeLayoutStyles([element], () => {
        write()
        this.readPaintSource(element, projection)
      })

      return
    }

    write()
  }

  private readPaintSource(element: HTMLElement, projection: LayoutStyleProjection) {
    this.layoutStyleSources
      .get(element)
      ?.read(
        element,
        projection.width,
        projection.height,
        layoutStyleSourceRevision(element.ownerDocument),
        layoutStyleSourceTimes(element),
      )
  }

  refreshPaintSources(prepared: readonly ActiveTrack[]) {
    const elements = [
      ...new Set(
        prepared
          .filter((entry) => isLayoutStyleProperty(entry.track.property))
          .map((entry) => entry.receiver.element),
      ),
    ]

    observeLayoutStyles(elements, () => {
      for (const element of elements) {
        const projection = this.layoutEffects.get(element)?.styles

        if (projection) this.readPaintSource(element, projection)
      }
    })
  }

  suspendForRestore(elements?: ReadonlySet<HTMLElement>) {
    const projections = (this.host.disposed ? [] : [...this.layoutTransforms])
      .filter(([element]) => !elements || elements.has(element))
      .map(([element, transform]) => ({
        element,
        transform,
        constraints: this.layoutEffects.get(element)?.constraints,
        styles: this.layoutEffects.get(element)?.styles,
      }))

    for (const { element } of projections) this.layoutTransform(element, undefined)

    return () => {
      const observations = projections.flatMap(({ element, styles }) => {
        const observation =
          styles && this.layoutStyleObservation(element, styles.width, styles.height)

        return observation ? [observation] : []
      })

      observeLayoutStyles(
        observations.map((observation) => observation.element),
        () => {
          for (const observation of observations) observation.read()
        },
      )
      batchLayoutWrites(() => {
        for (const { element, transform, constraints, styles } of projections)
          this.layoutTransform(element, transform, constraints, styles)
      })
    }
  }

  private layoutGeneration = 0

  private layoutOwned: OwnedElement[] = []

  private readonly layoutStyleSources = new Map<HTMLElement, LayoutStyleBaseline>()

  private readonly layoutTransforms = new Map<HTMLElement, string>()

  private readonly layoutEffects = new Map<
    HTMLElement,
    {
      animation: Animation
      effect: KeyframeEffect
      constraints?: LayoutBoxConstraints
      styles?: LayoutStyleProjection
      correction: ReadonlyMap<string, string>
      releaseStyleSource: () => void
      addresses: Set<string>
    }
  >()

  private readonly layoutMeasurements = new Map<Animation, 'active' | 'releasing'>()

  get layoutRevision() {
    return this.layoutGeneration
  }

  /** Potential targets include inactive declarations, so enablement captures a fresh shape. */
  layoutCandidates(transactionRevision?: number): readonly LayoutCandidate[] {
    if (this.host.disposed) return []

    const configurations =
      transactionRevision !== undefined && transactionRevision === this.layoutRevision
        ? resolveLayoutConfigurations(
            this.host.definition,
            this.host.values,
            this.host.layerResolution.composition,
          )
        : (this.host.layerResolution.layout ?? [])
    const candidates = new Map<HTMLElement, LayoutCandidate>()

    for (const target of declarationTargets(this.host.definition)) {
      if (!target.properties.some((property) => 'kind' in property)) continue

      for (const receiver of this.host.targetReceivers.get(target.name) ?? []) {
        const element = receiver.element
        const explicit = this.host.layerResolution.presentation.targets.some(
          (selected) =>
            this.host.targetReceivers
              .get(selected.name)
              ?.some((binding) => binding.element === element) &&
            selected.properties.some((property) => property.name === 'transform'),
        )
        const scoped =
          this.host.lifecycleOwns(element, 'transform') ||
          this.host.active.some(
            (entry) => entry.receiver.element === element && entry.track.property === 'transform',
          )
        candidates.set(element, {
          element,
          spring: this.host.spring?.trajectory,
          configuration:
            configurations.find((configuration) => configuration.target === target.name) ??
            candidates.get(element)?.configuration,
          blocked:
            this.host.suspended ||
            this.host.presentationMode !== 'live' ||
            this.host.motion.matches ||
            explicit ||
            scoped,
        })
      }
    }

    return [...candidates.values()]
  }

  /**
   * Temporary projection overrides CSS at important priority. Ordinary style writes
   * and generated output use the same ownership/rebase implementation, with separate
   * lifetimes so release reveals current CSS, including intervening inline edits.
   * Optional constraints are fixed used CSS lengths captured from the natural box:
   * they retain destination padding/text layout when an absolute containing block
   * changes. Undefined transform releases all temporary properties and native output.
   */
  layoutTransform(
    element: HTMLElement,
    transform: string | undefined,
    constraints?: LayoutBoxConstraints,
    styles?: LayoutStyleProjection,
  ) {
    batchLayoutWrites((finishLayoutWrites) => {
      if (transform === undefined) {
        const output = this.layoutEffects.get(element)
        const owned = this.layoutOwned.find((entry) => entry.element === element)
        if (owned)
          writeLayoutStyle(element, () => {
            element.style.cssText = restoredStyle(owned, element.style.cssText).cssText
          })

        if (output) {
          output.animation.cancel()
          // Discard transform transitions created from generated values, so release
          // cannot continue a size interpolation after projection has ended. This
          // target's transform and optional stabilization properties were owned;
          // unrelated properties/elements stay intact.
          finishLayoutWrites(
            element,
            [...output.addresses, ...(output.constraints?.keys() ?? [])],
            () => {
              // A later write in the same phase may have reacquired this output.
              if (
                this.layoutEffects.get(element) === output &&
                !this.layoutTransforms.has(element)
              ) {
                const current = this.layoutOwned.find((entry) => entry.element === element)
                current?.history?.dispose()
                output.releaseStyleSource()
                this.layoutEffects.delete(element)
                this.layoutStyleSources.delete(element)
                this.layoutOwned = this.layoutOwned.filter((entry) => entry !== current)
              }
            },
          )
        }

        // Retain ownership until restoration succeeds, so failed cleanup remains
        // retryable by the executor's later teardown rather than becoming orphaned.
        this.layoutTransforms.delete(element)
        if (!output) this.layoutStyleSources.delete(element)
        return
      }

      let output = this.layoutEffects.get(element)
      const created = output === undefined
      const projection = styles ?? output?.styles
      const correction = projection
        ? this.layoutStyleSource(element).correct(projection.distortion)
        : new Map<string, string>()
      const previousCorrection = output?.correction
      const correctionChanged =
        previousCorrection !== undefined &&
        (previousCorrection.size !== correction.size ||
          [...correction.keys()].some((property) => !previousCorrection.has(property)))
      const sizingChanged =
        correctionChanged ||
        (output?.constraints?.size ?? 0) !== (constraints?.size ?? 0) ||
        [...(constraints ?? [])].some(
          ([property, value]) => output?.constraints?.get(property) !== value,
        )
      if (sizingChanged) {
        const owned = this.layoutOwned.find((entry) => entry.element === element)
        if (owned) {
          writeLayoutStyle(element, () => {
            element.style.cssText = restoredStyle(owned, element.style.cssText).cssText
          })
          owned.history?.dispose()
          this.layoutOwned = this.layoutOwned.filter((entry) => entry !== owned)
        }
        finishLayoutWrites(element, [
          'transform',
          ...(output?.addresses ?? []),
          ...(output?.constraints?.keys() ?? []),
          ...(constraints?.keys() ?? []),
        ])
      }
      if (!output) {
        finishLayoutWrites(element, [
          'transform',
          ...(constraints?.keys() ?? []),
          ...correction.keys(),
        ])
        const effect = new KeyframeEffect(element, [{ transform }, { transform }], {
          duration: 1,
          fill: 'both',
        })
        const animation = new Animation(effect, element.ownerDocument.timeline)
        output = {
          animation,
          effect,
          correction: new Map(),
          addresses: new Set(['transform']),
          releaseStyleSource: ownLayoutStyleSource(
            element,
            () => this.prepareStyleSource(element),
            batchLayoutWrites,
          ),
        }
        this.layoutEffects.set(element, output)
      }

      if (sizingChanged || created) {
        const owner = output
        finishLayoutWrites(
          element,
          ['transform', ...(constraints?.keys() ?? []), ...correction.keys()],
          (addresses) => {
            for (const address of addresses) owner.addresses.add(address)
          },
        )
      }

      if (output.animation.playState === 'idle') {
        output.animation.pause()
        output.animation.currentTime = 0
      }

      // CSS transitions can interpolate even an important inline transform. A
      // generic effect gives this same owned value later animation composite order;
      // the inline path still overrides author-important declarations. Both paths
      // carry the identical numeric output and have one Executor-owned lifetime.
      const frame = {
        transform,
        ...Object.fromEntries(
          [...(constraints ?? []), ...correction].map(([property, value]) => [
            waapiProperty(property),
            value,
          ]),
        ),
      }
      output.effect.setKeyframes([frame, frame])
      this.write(element, 'transform', transform)
      if (sizingChanged)
        for (const [property, value] of constraints ?? []) this.write(element, property, value)
      for (const [property, value] of correction) this.write(element, property, value)
      if (sizingChanged) output.constraints = constraints ? new Map(constraints) : undefined
      output.correction = correction
      output.styles = projection
      this.layoutTransforms.set(element, transform)
    })
  }

  /** Supplies fresh CSS/Liva paint values without reading geometry or restarting authored effects. */
  layoutStyleObservation(
    element: HTMLElement,
    width: number,
    height: number,
  ): LayoutStyleObservation | undefined {
    const baseline = this.layoutStyleSource(element)
    const times = layoutStyleSourceTimes(element)
    if (baseline.matches(width, height, layoutStyleSourceRevision(element.ownerDocument), times))
      return undefined

    return {
      element,
      read: () =>
        baseline.read(
          element,
          width,
          height,
          layoutStyleSourceRevision(element.ownerDocument),
          times,
        ),
    }
  }

  private layoutStyleSource(element: HTMLElement): LayoutStyleBaseline {
    let baseline = this.layoutStyleSources.get(element)

    if (!baseline) {
      baseline = new LayoutStyleBaseline()
      this.layoutStyleSources.set(element, baseline)
    }

    return baseline
  }

  /** Only paint output is excluded; transform and fixed layout stabilization remain installed. */
  private prepareStyleSource(element: HTMLElement): () => void {
    const output = this.layoutEffects.get(element)
    const owned = this.layoutOwned.find((entry) => entry.element === element)
    const transform = this.layoutTransforms.get(element)
    if (!output || !owned || output.correction.size === 0 || transform === undefined)
      return () => {}
    const restore = () => {
      if (
        !this.host.disposed &&
        this.layoutEffects.get(element) === output &&
        this.layoutTransforms.has(element)
      )
        this.layoutTransform(
          element,
          this.layoutTransforms.get(element),
          output.constraints,
          output.styles,
        )
    }

    try {
      const source = restoredStyle(owned, element.style.cssText)
      const frame = {
        transform,
        ...Object.fromEntries(
          [...(output.constraints ?? [])].map(([property, value]) => [
            waapiProperty(property),
            value,
          ]),
        ),
      }
      output.effect.setKeyframes([frame, frame])
      writeLayoutStyle(element, () => {
        element.style.cssText = source.cssText
      })
      // Preserve all geometry declarations with their existing important priority.
      for (const [property, value] of [['transform', transform], ...(output.constraints ?? [])])
        writeLayoutStyle(element, () => element.style.setProperty(property, value, 'important'))
    } catch (error) {
      releaseResources([
        () => {
          throw error
        },
        restore,
      ])
    }

    return restore
  }

  /**
   * Excludes visual transforms for one synchronous read while preserving unrelated
   * authored declarations and native effect objects. A generic replacement has later effect
   * order than CSS transitions/animations. The collector verifies actual cascade
   * effectiveness; author important declarations may still defeat this overlay.
   */
  layoutMeasure(element: HTMLElement, properties: ReadonlyMap<string, string>): () => void {
    this.retryLayoutMeasurements()
    const frame = Object.fromEntries(
      [...properties].map(([property, value]) => [waapiProperty(property), value]),
    )
    const animation = new Animation(
      new KeyframeEffect(element, [frame, frame], { duration: 1, fill: 'both' }),
      element.ownerDocument.timeline,
    )
    this.layoutMeasurements.set(animation, 'active')
    const projection = this.layoutTransforms.get(element)
    const constraints = this.layoutEffects.get(element)?.constraints

    try {
      animation.pause()
      animation.currentTime = 0
      // Neutralize only generated visual projection. Keep its fixed logical size
      // constraints/padding during this collector read so destination text/containing-block
      // layout stays stable. The shared natural-measurement prepare phase releases
      // all output instead. Unrelated authored effects keep their own clocks.
      if (projection !== undefined)
        this.layoutTransform(element, 'matrix(1, 0, 0, 1, 0, 0)', constraints)
    } catch (error) {
      releaseResources([
        () => {
          throw error
        },
        () => this.cancelLayoutMeasurement(animation),
      ])
    }

    return () => {
      if (this.layoutMeasurements.get(animation) !== 'active') {
        this.cancelLayoutMeasurement(animation)
        return
      }

      try {
        if (projection !== undefined && !this.host.disposed)
          this.layoutTransform(element, projection, constraints)
      } finally {
        this.cancelLayoutMeasurement(animation)
      }
    }
  }

  /** Releases temporary output and retries retained observation cleanup. Failed resources stay owned. */
  layoutCleanup() {
    this.releaseLayout()
  }

  private cancelLayoutMeasurement(animation: Animation) {
    if (!this.layoutMeasurements.has(animation)) return

    this.layoutMeasurements.set(animation, 'releasing')
    animation.cancel()
    this.layoutMeasurements.delete(animation)
  }

  private retryLayoutMeasurements() {
    releaseResources(
      [...this.layoutMeasurements]
        .filter(([, state]) => state === 'releasing')
        .map(
          ([animation]) =>
            () =>
              this.cancelLayoutMeasurement(animation),
        ),
    )
  }

  releaseLayout() {
    batchLayoutWrites(() =>
      releaseResources([
        ...[
          ...new Set([
            ...this.layoutTransforms.keys(),
            ...this.layoutEffects.keys(),
            ...this.layoutStyleSources.keys(),
          ]),
        ].map((element) => () => this.layoutTransform(element, undefined)),
        ...[...this.layoutMeasurements.keys()].map(
          (animation) => () => this.cancelLayoutMeasurement(animation),
        ),
      ]),
    )
  }
}
