import { describe, expect, it } from 'vite-plus/test'
import type { RuntimeValue } from '../reactive-value.ts'
import { measure } from './measure.ts'

describe('measure argument validation', () => {
  it.each<Readonly<Record<string, RuntimeValue>>>([
    {},
    { target: 1 },
    { target: { name: false } },
    { target: { name: 'self' }, relativeTo: true },
  ])('rejects invalid target arguments %j', (args) => {
    expect(() => measure(args)).toThrow('target')
  })

  it('retains a zero unattached snapshot when no browsing targets exist', () => {
    const source = measure({ target: { name: 'missing' } })
    const cleanup = source.bind(new Map(), () => {
      throw new Error('No geometry can change')
    })

    expect(source.value).toEqual({ x: 0, y: 0, width: 0, height: 0, attached: false })

    cleanup()
  })
})
