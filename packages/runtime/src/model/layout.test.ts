import { describe, expect, it } from 'vite-plus/test'
import { freezeDefinition } from './definition.ts'
import { isLayoutAxes, type LayoutDeclaration } from './layout.ts'

describe('layout configuration contract', () => {
  it.each([
    { x: false, y: false, width: false, height: false },
    { x: false, y: true, width: false, height: true },
    { x: true, y: true, width: true, height: true },
  ])('accepts complete physical axes: %j', (axes) => {
    expect(isLayoutAxes(axes)).toBe(true)
  })

  it.each([
    null,
    [],
    { x: true, y: false, width: true },
    { x: 1, y: false, width: true, height: false },
    { x: true, y: false, width: true, height: false, anchor: 'center' },
  ])('rejects malformed or unsupported axes: %j', (axes) => {
    expect(isLayoutAxes(axes)).toBe(false)
  })

  it('freezes the selection independently of CSS values', () => {
    const declaration: LayoutDeclaration = {
      kind: 'layout',
      name: '$layout',
      axes: { x: false, y: true, width: false, height: true },
    }

    freezeDefinition(declaration)

    expect(Object.isFrozen(declaration.axes)).toBe(true)
    expect(() => Object.assign(declaration.axes, { y: false })).toThrow(TypeError)
  })
})
