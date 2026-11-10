import { describe, expect, it } from 'vite-plus/test'
import { encodeProperty } from './property-codec.ts'

describe('canonical property encoding', () => {
  it.each([
    ['width', [-10.5], false, '-10.5px'],
    ['width', [-10.5], true, '0px'],
    ['inline-size', [20.5], true, '20.5px'],
    ['inset-inline-start', [-10.5], true, '-10.5px'],
    ['inset', [1, -2, 3, -4], false, '1px -2px 3px -4px'],
    ['rotate', [-30.5], true, '-30.5deg'],
    ['translate', [-10.5, 20, 7], true, '-10.5px 20px 7px'],
    ['scale', [0.5, -2, 1], true, '0.5 -2 1'],
    ['opacity', [-0.1], false, '0'],
    ['opacity', [0.5], false, '0.5'],
    ['opacity', [1.2], true, '1'],
  ] as const)(
    'encodes %s components %j with bounded=%s as %s',
    (property, values, bounded, expected) => {
      expect(encodeProperty(property, values, bounded)).toBe(expected)
    },
  )

  it('uses unbounded output by default', () => {
    expect(encodeProperty('width', [-10])).toBe('-10px')
  })

  it('leaves unsupported CSS properties outside numeric encoding', () => {
    expect(encodeProperty('background-color', [1])).toBeUndefined()
  })
})
