import { components, numeric } from '../motion/computed-value.ts'
import { inverseProjection, type ProjectionMatrix } from './projection.ts'

/** Horizontal and vertical ellipse semiaxes in untransformed border-box CSS px. */
export interface Radius {
  readonly x: number
  readonly y: number
}

/** Uncorrected corners ordered top-left, top-right, bottom-right, bottom-left. */
export type CornerRadii = readonly [Radius, Radius, Radius, Radius]

/** Uncorrected computed shadow. Lengths use CSS px; color retains computed syntax verbatim. */
export interface BoxShadow {
  readonly x: number
  readonly y: number
  readonly blur: number
  readonly spread: number
  readonly inset: boolean
  readonly color: string
}

/** Positive cumulative generated scale magnitudes in target-local x/y axes. */
export interface CorrectionScale {
  readonly x: number
  readonly y: number
}

/**
 * Cumulative generated local affine distortion, or positive diagonal scales as
 * shorthand. Coefficients may be inherited/getter-backed, including a 2D DOMMatrix.
 */
export type CorrectionTransform = CorrectionScale | ProjectionMatrix

/**
 * Decodes four browser-validated computed radius longhands in clockwise corner order.
 * Percentages use untransformed border-box width for x and height for y. CSS's common
 * overlap-reduction factor is applied to preserve used corner shapes. Wrong corner
 * count, negative/nonfinite dimensions, or unsupported components return undefined.
 */
export function decodeCornerRadii(
  values: readonly string[],
  width: number,
  height: number,
): CornerRadii | undefined {
  if (
    values.length !== 4 ||
    ![width, height].every((value) => Number.isFinite(value) && value >= 0)
  )
    return undefined

  const corners: Radius[] = []

  for (const value of values) {
    const parts = components(value.trim())

    if (parts.length < 1 || parts.length > 2) return undefined

    const x = numeric(parts[0], width)
    const y = numeric(parts[1] ?? parts[0], height)

    if (x === undefined || y === undefined || x < 0 || y < 0) return undefined

    corners.push({ x, y })
  }

  const [tl, tr, br, bl] = corners
  const ratios = [
    [width, tl.x + tr.x],
    [width, bl.x + br.x],
    [height, tl.y + bl.y],
    [height, tr.y + br.y],
  ]
  const factor = Math.min(1, ...ratios.map(([size, sum]) => (sum === 0 ? 1 : size / sum)))
  const corrected = corners.map(({ x, y }) => ({ x: x * factor, y: y * factor }))

  // Every one of the four validated input longhands produced a corner above.
  return [corrected[0], corrected[1], corrected[2], corrected[3]]
}

/** Separates shadow layers without splitting nested color-function commas. */
function shadowLayers(value: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index <= value.length; index++) {
    const character = value[index]

    if (character === '(') depth++
    if (character === ')') depth--

    if (index === value.length || (depth === 0 && character === ',')) {
      result.push(value.slice(start, index).trim())
      start = index + 1
    }
  }

  return result
}

/**
 * Decodes browser-validated computed box-shadow, including multiple/inset layers and
 * nested colors. Accepts two to four resolved px length components (or unitless zero),
 * retaining the computed color without parsing color syntax. `none` returns [].
 * Incomplete layers, unsupported lengths, nonfinite lengths or negative blur return
 * undefined. This is a computed snapshot decoder, not an authored CSS validator.
 */
export function decodeBoxShadows(value: string): readonly BoxShadow[] | undefined {
  if (value.trim() === 'none') return []

  const shadows: BoxShadow[] = []

  for (const layer of shadowLayers(value)) {
    const lengths: number[] = []
    const colors: string[] = []
    let inset = false

    for (const part of components(layer)) {
      if (part === 'inset') {
        if (inset) return undefined

        inset = true
      } else if (/^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px)?$/.test(part)) {
        const length = numeric(part, 0)

        if (length === undefined) return undefined

        lengths.push(length)
      } else {
        colors.push(part)
      }
    }

    if (lengths.length < 2 || lengths.length > 4 || colors.length !== 1) return undefined

    const [x, y, blur = 0, spread = 0] = lengths

    if (blur < 0) return undefined

    shadows.push({ x, y, blur, spread, inset, color: colors[0] })
  }

  return shadows
}

function correctionBasis(correction: CorrectionTransform) {
  const matrix =
    'a' in correction
      ? { a: correction.a, b: correction.b, c: correction.c, d: correction.d, e: 0, f: 0 }
      : { a: correction.x, b: 0, c: 0, d: correction.y, e: 0, f: 0 }

  if (!('a' in correction) && (correction.x <= 0 || correction.y <= 0)) return undefined

  const inverse = inverseProjection(matrix)

  if (!inverse) return undefined

  return {
    inverse,
    x: Math.hypot(matrix.a, matrix.b),
    y: Math.hypot(matrix.c, matrix.d),
    radial: Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)),
  }
}

/**
 * Encodes corrected radius longhands from an uncorrected decoded baseline. Supply
 * cumulative generated local distortion including participating ancestors. Never
 * feed previous output back as baseline. Axis scaling is exact before CSS's final
 * overlap reduction. CSS axis-aligned ellipses cannot exactly undo genuine shear;
 * dividing by local column magnitudes approximates it, leaving a shape residual.
 * Singular/nonfinite corrections or unrepresentable output lengths return undefined.
 */
export function correctCornerRadii(
  radii: CornerRadii,
  correction: CorrectionTransform,
): readonly [string, string, string, string] | undefined {
  const scale = correctionBasis(correction)

  if (!scale) return undefined

  const corrected = radii.map(({ x, y }) => ({ x: x / scale.x, y: y / scale.y }))

  if (!corrected.every((radius) => Number.isFinite(radius.x) && Number.isFinite(radius.y)))
    return undefined

  const values = corrected.map(({ x, y }) => `${x}px ${y}px`)

  return [values[0], values[1], values[2], values[3]]
}

/**
 * Encodes fresh shadow correction from an uncorrected decoded baseline. Offsets
 * use the full inverse linear map (axis division for diagonal scale). CSS has one
 * scalar blur/spread radius, so divide by sqrt(abs(det(correction))), the geometric
 * mean of principal scales. This preserves area, not circular shape: diagonal x/y
 * scale leaves displayed radial axes multiplied by sqrt(x/y) and sqrt(y/x). Genuine
 * shear likewise leaves radial distortion. This approximation does not limit box
 * projection support. Translation in a supplied matrix is ignored.
 * Singular/nonfinite corrections or unrepresentable lengths return undefined;
 * an empty shadow list returns `none`. Never reuse correction output as baseline.
 */
export function correctBoxShadows(
  shadows: readonly BoxShadow[],
  correction: CorrectionTransform,
): string | undefined {
  const scale = correctionBasis(correction)

  if (!scale) return undefined

  const corrected: string[] = []

  for (const shadow of shadows) {
    const lengths = [
      scale.inverse.a * shadow.x + scale.inverse.c * shadow.y,
      scale.inverse.b * shadow.x + scale.inverse.d * shadow.y,
      shadow.blur / scale.radial,
      shadow.spread / scale.radial,
    ]

    if (!lengths.every(Number.isFinite)) return undefined

    corrected.push(
      `${shadow.inset ? 'inset ' : ''}${lengths.map((value) => `${value}px`).join(' ')} ${shadow.color}`,
    )
  }

  return corrected.length === 0 ? 'none' : corrected.join(', ')
}
