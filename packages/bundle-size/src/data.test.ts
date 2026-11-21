import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { array, environment, number, object, text } from './data.ts'

afterEach(() => vi.unstubAllEnvs())

describe('untrusted input narrowing', () => {
  it.each([null, [], 1, 'record', true])('rejects non-record input: %j', (value) => {
    expect(() => object(value)).toThrow('Expected object')
  })

  it('retains accepted containers without discarding keys or array order', () => {
    const record = { field: ['one', 'two'] }
    expect(object(record)).toBe(record)
    expect(array(record.field)).toBe(record.field)
    expect(text('')).toBe('')
    expect(number(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-positive or unsafe IDs: %j',
    (value) => {
      expect(() => number(value)).toThrow('Expected positive integer')
    },
  )

  it('distinguishes missing environment from present text and rejects scalar coercion', () => {
    vi.stubEnv('BUNDLE_SIZE_UNIT_VALUE', 'present')
    expect(environment('BUNDLE_SIZE_UNIT_VALUE')).toBe('present')
    vi.stubEnv('BUNDLE_SIZE_UNIT_VALUE', '')
    expect(() => environment('BUNDLE_SIZE_UNIT_VALUE')).toThrow('Missing BUNDLE_SIZE_UNIT_VALUE')
    expect(() => text(['coercible'])).toThrow('Expected string')
    expect(() => array({ 0: 'not an array' })).toThrow('Expected array')
  })
})
