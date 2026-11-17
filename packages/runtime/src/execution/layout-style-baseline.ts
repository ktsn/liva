import type { LayoutStyleSourceTime } from '../layout/style-observation.ts'
import {
  decodeCornerRadii,
  decodeBoxShadows,
  correctCornerRadii,
  correctBoxShadows,
  type CornerRadii,
  type BoxShadow,
} from '../layout/style-correction.ts'
import { layoutRadiusProperties } from '../layout/style-properties.ts'
import type { ProjectionMatrix } from '../layout/projection.ts'

/** Decoded visual groups fail independently; undefined leaves that source CSS uncorrected. */
export interface LayoutStyleSource {
  readonly radii?: CornerRadii
  readonly shadows?: readonly BoxShadow[]
}

/** Applies existing pure correction math, preserving every independently representable group. */
export function correctLayoutStyles(
  source: LayoutStyleSource,
  distortion: ProjectionMatrix,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  const radii = source.radii && correctCornerRadii(source.radii, distortion)
  const shadows = source.shadows && correctBoxShadows(source.shadows, distortion)

  if (radii)
    for (const [index, property] of layoutRadiusProperties.entries())
      values.set(property, radii[index])
  if (shadows !== undefined) values.set('box-shadow', shadows)

  return values
}

/**
 * An uncorrected browser-computed source, separate from generated style output.
 * Dimensions refer to natural destination layout, including when a generated
 * containing block gives the renderer a different local sizing basis.
 */
export class LayoutStyleBaseline {
  private times: readonly LayoutStyleSourceTime[] = []
  private revision: number | undefined
  private width: number | undefined
  private height: number | undefined
  private radii: CornerRadii | undefined
  private shadows: readonly BoxShadow[] | undefined

  matches(
    width: number,
    height: number,
    revision: number,
    times: readonly LayoutStyleSourceTime[],
  ): boolean {
    return (
      this.width === width &&
      this.height === height &&
      this.revision === revision &&
      this.times.length === times.length &&
      times.every(
        (sample, index) =>
          sample.animation === this.times[index].animation &&
          sample.time === this.times[index].time,
      )
    )
  }

  read(
    element: HTMLElement,
    width: number,
    height: number,
    revision: number,
    times: readonly LayoutStyleSourceTime[],
  ) {
    const style = getComputedStyle(element)
    const radii = decodeCornerRadii(
      layoutRadiusProperties.map((property) => style.getPropertyValue(property)),
      width,
      height,
    )
    const shadows = decodeBoxShadows(style.boxShadow)

    this.times = times
    this.revision = revision
    this.radii = radii
    this.shadows = shadows
    this.width = width
    this.height = height
  }

  /** Unsupported source syntax/correction drops that visual group, retaining valid box projection. */
  correct(distortion: ProjectionMatrix): ReadonlyMap<string, string> {
    return correctLayoutStyles({ radii: this.radii, shadows: this.shadows }, distortion)
  }
}
