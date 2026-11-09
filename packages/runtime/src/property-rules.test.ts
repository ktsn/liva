import { describe, expect, it } from 'vite-plus/test'
import { propertyRule, resolvePropertyComponents } from './property-rules.ts'

describe('numeric property rules', () => {
  it.each(['background-color', 'constructor', 'toString'])(
    'keeps unsupported property %s outside the numeric registry',
    (property) => {
      expect(propertyRule(property)).toBeUndefined()
    },
  )

  it.each([
    ['', ['left', 'right']],
    ['unknown-rl', ['right', 'left']],
  ])(
    'preserves block-flow fallback for an unrecognized writing mode %j',
    (writingMode, expected) => {
      const rule = propertyRule('inset-block')
      if (!rule) throw new Error('Expected inset-block support')

      expect(resolvePropertyComponents(rule, { writingMode, direction: 'ltr' })).toEqual(expected)
    },
  )
})
