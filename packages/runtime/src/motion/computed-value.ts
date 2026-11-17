/** Splits space-separated computed components while keeping CSS math expressions intact. */
export function components(value: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index <= value.length; index++) {
    const character = value[index]
    if (character === '(') depth++
    if (character === ')') depth--

    if (index === value.length || (depth === 0 && /\s/.test(character))) {
      // Ignore edge/repeated whitespace while retaining nested CSS functions intact.
      if (index > start) result.push(value.slice(start, index))
      start = index + 1
    }
  }

  return result
}

/**
 * Reads one nonempty, browser-validated computed CSS component as a finite number.
 * Supports unitless numbers, px, deg, percentages, and normalized calc/min/max/clamp
 * expressions. Unsupported tokens or nonfinite results return undefined; this is
 * not a validator or unit resolver for arbitrary authored CSS.
 *
 * @param reference The numeric value represented by 100%, in the result's units.
 * For translate X/Y this is the element's border-box width/height in px; for
 * unitless scale/opacity it is 1. Callers pass 0 when the computed component is
 * expected to have no remaining percentage, such as a resolved length or rotation.
 */
export function numeric(value: string, reference: number): number | undefined {
  // Numeric inputs are nonempty computed CSS values; even unsupported keywords tokenize.
  const tokens = value.match(/(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px|%|deg)?|[a-zA-Z]+|[()+*/,-]/g)
  if (!tokens || tokens.join('') !== value.replace(/\s/g, '')) return undefined
  let cursor = 0

  /** Reads a primary expression or unary minus, resolving percentages against reference. */
  const atom = (): number => {
    const token = tokens[cursor++]
    if (token === '-') return -atom()

    if (token === '(') {
      const result = sum()
      cursor++ // Computed CSSOM math is syntactically balanced.
      return result
    }

    if (['calc', 'min', 'max', 'clamp'].includes(token)) {
      cursor++ // CSSOM validates the function delimiter and arity.
      const args = [sum()]

      while (tokens[cursor] === ',') {
        cursor++
        args.push(sum())
      }

      cursor++ // Computed CSSOM math is syntactically balanced.
      if (token === 'calc') return args[0]
      if (token === 'min') return Math.min(...args)
      if (token === 'max') return Math.max(...args)
      return Math.max(args[0], Math.min(args[1], args[2]))
    }

    const match = token?.match(/^((?:\d*\.)?\d+(?:e[+-]?\d+)?)(px|%|deg)?$/)
    if (!match) return NaN
    const number = Number(match[1])
    const unit = match[2]
    // reference supplies the value of 100% in the output's units:
    // 50% of a 200px translate axis becomes 100px before arithmetic is evaluated.
    if (unit === '%') return (number * reference) / 100
    // Computed rotation is serialized in degrees, including authored rad/grad/turn.
    return number
  }

  /** Reads multiplication before addition, using CSSOM's normalized numeric factors. */
  const product = (): number => {
    let result = atom()

    // Computed CSS normalizes numeric division to a multiplicative coefficient.
    while (tokens[cursor] === '*') {
      cursor++
      result *= atom()
    }

    return result
  }

  /** Reads an additive expression up to a comma, closing delimiter, or the end of input. */
  const sum = (): number => {
    let result = product()

    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const operator = tokens[cursor++]
      const right = product()
      result = operator === '+' ? result + right : result - right
    }

    return result
  }

  const result = sum()
  return cursor === tokens.length && Number.isFinite(result) ? result : undefined
}
