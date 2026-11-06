import { describe, expect, it } from 'vite-plus/test'
import { evaluate, evaluateScalar, renderValue, renderTransition } from './expression.ts'
import { resolveComposition, resolveLayerTracks } from './layers.ts'
import type { Definition, Expression } from './definition.ts'

const number = (value: number): Expression => ({ kind: 'number', value })

describe('expression evaluation', () => {
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
                value: '0px',
                template: [{ kind: 'reference', path: ['x'] }, 'px'],
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
    expect(definition.layers[1].targets[0].properties[0].value).toBe('0px')
    expect(renderValue({ value: 'auto' }, {})).toBe('auto')
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
        { name: 'off', targets: [{ name: 'body', properties: [{ name: 'opacity', value: '0' }] }] },
        {
          name: 'on',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: '1',
                  timingExpression: quick,
                  keyframes: [
                    {
                      offset: 0.5,
                      value: '.7',
                      easingExpression: { kind: 'reference', path: ['easeOut'] },
                    },
                  ],
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
                  value: '',
                  template: [{ kind: 'reference', path: ['x'] } as Expression, 'px'],
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
      value: '10px',
      easing: 'ease-in',
    })
    expect(second.targets[0].properties[0].keyframes?.[0].value).toBe('20px')
    expect(source.targets[0].properties[0].keyframes[0].value).toBe('')
  })
})
