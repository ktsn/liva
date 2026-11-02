import { describe, expect, it } from 'vite-plus/test'
import { evaluate, evaluateScalar, renderDefinition, renderValue } from './expression.ts'
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

  it('renders only requested states without mutating the definition', () => {
    const definition: Definition = {
      name: 'position',
      directionalTransitions: [],
      states: ['off', 'on'].map((name) => ({
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
    const rendered = renderDefinition(definition, { x: 12 }, ['on'])

    expect(rendered.states[0]).toBe(definition.states[0])
    expect(rendered.states[1].targets[0].properties[0].value).toBe('12px')
    expect(definition.states[1].targets[0].properties[0].value).toBe('0px')
    expect(renderValue({ value: 'auto' }, {})).toBe('auto')
  })
})
