import assert from 'node:assert/strict'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Narrow JSON containers before reading fields; arrays are not records. */
export function object(value: unknown): Record<string, unknown> {
  assert(isRecord(value), 'Expected object')

  return value
}

export function text(value: unknown): string {
  assert(typeof value === 'string', 'Expected string')

  return value
}

export function number(value: unknown): number {
  assert(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'Expected positive integer',
  )

  return value
}

export function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected array')

  return value
}

export function environment(name: string): string {
  const value = process.env[name]

  assert(value, `Missing ${name}`)

  return value
}
