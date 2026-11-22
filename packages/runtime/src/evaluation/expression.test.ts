import { isCssProperty } from '../model/definition.ts'
import { describe, expect, it } from 'vite-plus/test'
import {
  evaluate,
  evaluateScalar,
  renderValue,
  renderProperty,
  renderTransition,
} from './expression.ts'
import { resolveComposition, resolveLayerTracks } from '../composition/layers.ts'
import type { Definition, Expression, Property } from '../model/definition.ts'

const number = (value: number): Expression => ({ kind: 'number', value })

describe('expression evaluation', () => {
  it.each(['tween', 'drag'])('rejects a call when %s is shadowed by a motion value', (name) => {
    const expression: Expression = { kind: 'call', function: name, arguments: [] }

    expect(() => evaluate(expression, { [name]: 1 })).toThrow(`Value is not callable: ${name}`)
  })

  it.each([
    ['==', 3, 3, true],
    ['===', 3, 4, false],
    ['!=', 3, 4, true],
    ['!==', 3, 3, false],
    ['<', 3, 4, true],
    ['<=', 3, 3, true],
    ['>', 4, 3, true],
    ['>=', 3, 3, true],
    ['+', 7, 2, 9],
    ['-', 7, 2, 5],
    ['*', 7, 2, 14],
    ['/', 7, 2, 3.5],
    ['%', 7, 2, 1],
    ['&&', 1, 0, false],
    ['&&', 1, 2, true],
    ['||', 0, 2, true],
    ['||', 0, 0, false],
    ['||', 1, 0, true],
  ])('evaluates %s with %s and %s', (operator, left, right, expected) => {
    expect(
      evaluate(
        {
          kind: 'binary',
          operator: operator,
          left: number(left),
          right: number(right),
        },
        {},
      ),
    ).toBe(expected)
  })

  it.each([
    [3, 3, true],
    [3, 4, false],
    ['a', 'a', true],
    ['a', 'b', false],
    [true, true, true],
    [true, false, false],
    [1, '1', false],
    [0, false, false],
    ['', false, false],
  ])('compares %s and %s without coercion', (left, right, equal) => {
    for (const operator of ['==', '!=']) {
      expect(
        evaluate(
          {
            kind: 'binary',
            operator,
            left: { kind: 'reference', path: ['left'] },
            right: { kind: 'reference', path: ['right'] },
          },
          { left, right },
        ),
      ).toBe(operator === '==' ? equal : !equal)
    }
  })

  it.each([
    ['!', 0, true],
    ['-', 3, -3],
    ['+', 3, 3],
  ] as const)('evaluates unary %s', (operator, value, expected) => {
    expect(evaluate({ kind: 'unary', operator, operand: number(value) }, {})).toBe(expected)
  })

  it('rejects missing and inherited references and scalar member access', () => {
    for (const path of [['missing'], ['toString'], ['value', 'x'], ['nested', 'missing']]) {
      expect(() => evaluate({ kind: 'reference', path }, { value: 1, nested: { x: 2 } })).toThrow(
        'Unknown variable reference',
      )
    }

    expect(() =>
      evaluateScalar({ kind: 'reference', path: ['nested'] }, { nested: { x: 2 } }),
    ).toThrow('scalar')
  })

  it('requires a call context and rejects unsupported operators', () => {
    expect(() => evaluate({ kind: 'call', function: 'drag', arguments: [] }, {})).toThrow(
      'initializer context',
    )
    expect(() =>
      evaluate({ kind: 'binary', operator: '**', left: number(2), right: number(3) }, {}),
    ).toThrow('Unsupported expression operator')
  })

  it('renders only selected layers without mutating the definition', () => {
    const definition: Definition = {
      name: 'position',
      layers: ['off', 'on'].map((name) => ({
        name,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'translate',
                value: {
                  kind: 'template',
                  parts: [{ kind: 'reference', path: ['x'] }, 'px'],
                },
              },
            ],
          },
        ],
      })),
    }
    const rendered = resolveComposition(
      definition,
      { x: 12 },
      { layers: { off: false, on: true }, states: {} },
    )

    expect(rendered.composition.layers).toEqual({ off: false, on: true })
    expect(rendered.presentation.targets[0].properties[0].value).toBe('12px')
    const declaration = definition.layers[1].targets[0].properties[0]

    if (!isCssProperty(declaration)) throw new Error('Expected a CSS property')

    expect(declaration.value).toEqual({
      kind: 'template',
      parts: [{ kind: 'reference', path: ['x'] }, 'px'],
    })
    expect(
      renderValue(
        {
          kind: 'literal',
          value: 'auto',
        },
        {},
      ),
    ).toBe('auto')
  })
  it('resolves decorated property timing and frame easing from current values', () => {
    const quick: Expression = {
      kind: 'call',
      function: 'tween',
      arguments: [{ name: 'duration', value: { kind: 'reference', path: ['duration'] } }],
    }
    const definition: Definition = {
      name: 'fade',
      layers: [
        {
          name: 'off',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'on',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'keyframes',
                    frames: [
                      {
                        offset: 0.5,
                        value: {
                          kind: 'literal',
                          value: '.7',
                        },
                        easingExpression: { kind: 'reference', path: ['easeOut'] },
                      },
                      { offset: 1, value: { kind: 'literal', value: '1' } },
                    ],
                  },
                  timingExpression: quick,
                },
              ],
            },
          ],
        },
      ],
    }

    const from = { layers: { off: true, on: false }, states: {} }
    const to = { layers: { off: false, on: true }, states: {} }
    const previous = resolveComposition(definition, { duration: 125 }, from)
    const next = resolveComposition(definition, { duration: 125 }, to)
    const [track] = resolveLayerTracks(
      previous,
      next,
      { duration: 125 },
      () => '0',
      () => {},
    )

    expect(track.timing).toMatchObject({ kind: 'tween', durationMs: 125 })
    expect(track.keyframes[1]).toMatchObject({ value: '.7', easing: 'ease-out' })
    expect(track.destinationValue).toBe('1')
  })

  it('preserves a binding as a pending controller expression without evaluating it as CSS', () => {
    const expression: Expression = { kind: 'reference', path: ['movement'] }
    const property: Property = { name: 'translate', value: { kind: 'binding', expression } }

    const rendered = renderProperty(property, {})

    expect(rendered).toEqual({ name: 'translate', value: '', binding: expression })
    expect(rendered.binding).toBe(expression)
  })

  it('derives each keyframe destination from its structured endpoint without mutating the source', () => {
    const property: Property = {
      name: 'translate',
      value: {
        kind: 'keyframes',
        frames: [
          { offset: 0, value: { kind: 'literal', value: '0px' } },
          {
            offset: 1,
            value: { kind: 'template', parts: [{ kind: 'reference', path: ['x'] }, 'px'] },
          },
        ],
      },
    }
    const original = structuredClone(property)

    const first = renderProperty(property, { x: 12 })
    const second = renderProperty(property, { x: 20 })

    expect(first.value).toBe('12px')
    expect(first.keyframes?.map((frame) => frame.value)).toEqual(['0px', '12px'])
    expect(second.value).toBe('20px')
    expect(second.keyframes?.at(-1)?.value).toBe('20px')
    expect(property).toEqual(original)
  })

  it('rejects a direct style keyframe source without a destination', () => {
    const property: Property = {
      name: 'scale',
      value: {
        kind: 'keyframes',
        frames: [{ offset: 0.5, value: { kind: 'literal', value: '.5' } }],
      },
    }

    expect(() => renderProperty(property, {})).toThrow('100% destination')
  })

  it('renders transition timing, interpolation and easing as one immutable snapshot', () => {
    const source = {
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'translate',
              timingExpression: { kind: 'call', function: 'tween', arguments: [] } as Expression,
              keyframes: [
                {
                  offset: 1,
                  value: {
                    kind: 'template' as const,
                    parts: [{ kind: 'reference', path: ['x'] } as Expression, 'px'],
                  },
                  easingExpression: { kind: 'reference', path: ['easeIn'] } as Expression,
                },
              ],
            },
          ],
        },
      ],
    }

    const first = renderTransition(source, { x: 10 })
    const second = renderTransition(source, { x: 20 })

    expect(first.targets[0].properties[0].keyframes?.[0]).toMatchObject({
      value: { kind: 'literal', value: '10px' },
      easing: 'ease-in',
    })
    expect(second.targets[0].properties[0].keyframes?.[0].value).toEqual({
      kind: 'literal',
      value: '20px',
    })
    expect(source.targets[0].properties[0].keyframes[0].value).toEqual({
      kind: 'template',
      parts: [{ kind: 'reference', path: ['x'] }, 'px'],
    })
  })
})
