import { isCssProperty } from '../packages/runtime/src/model/definition.ts'
import { EvaluationFixture } from '../packages/runtime/src/__test__/helpers/evaluation.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile } from '../packages/vite/wasm/liva_wasm.js'
import type { Compilation } from '../packages/vite/src/compiler.ts'
import { decodeBundle } from '../packages/runtime/src/model/definition.ts'
import { parameterValues, targetValues } from '../packages/runtime/src/evaluation/let-bindings.ts'
import {
  renderProperty,
  type VariableValues,
} from '../packages/runtime/src/evaluation/expression.ts'

for (const name of [
  'layout-config',
  'constrained',
  'toggle',
  'self-target',
  'reactive-toggle',
  'card',
  'derived',
  'presence',
  'lifecycle',
  'interaction',
  'controller',
]) {
  const source = readFileSync(new URL(`../fixtures/${name}.liv`, import.meta.url), 'utf8')
  const expected = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  )
  const result = JSON.parse(compile(source, false))
  assert.deepEqual(result, expected)
  const bundle = decodeBundle(JSON.stringify(result))
  assert.equal(Object.isFrozen(bundle.definitions[0].layers), true)
  assert.equal('mappings' in bundle, false)
}
assert.throws(() => decodeBundle('{"schemaVersion":1,"definitions":[]}'), /Unsupported/)

const constrained = decodeBundle(
  compile(readFileSync(new URL('../fixtures/constrained.liv', import.meta.url), 'utf8'), false),
).definitions[0]

assert(constrained.parameters && constrained.letBindings)

const constrainedParameters = constrained.parameters
const constrainedInputs = parameterValues(constrainedParameters, targetValues(constrained), {
  position: 'start',
  axis: 'x',
})
const constrainedGraph = new EvaluationFixture(constrained.letBindings, constrainedInputs)
const constrainedValues = constrainedGraph.evaluate(constrainedInputs)

assert.equal(constrainedValues.selected, 'start')
assert.equal(constrainedValues.fixedAxis, 'x')

for (const inputs of [
  { position: 'middle', axis: 'x' },
  { position: false, axis: 'x' },
  { position: 'end', axis: 'y' },
  { position: 'end' },
  { position: 'end', axis: 'x', other: true },
]) {
  assert.throws(
    () => parameterValues(constrainedParameters, constrainedValues, inputs),
    /parameter/,
  )
  assert.equal(constrainedValues.selected, 'start')
}

const malformedChoices = structuredClone(constrained)

assert(malformedChoices.parameters)

Object.assign(malformedChoices.parameters[0], { type: { kind: 'stringUnion', values: [] } })

assert.throws(
  () => decodeBundle(JSON.stringify({ schemaVersion: 3, definitions: [malformedChoices] })),
  /schema/,
)

constrainedGraph.dispose()

const unicode = '// 😀\r\nmotion a { @tween(duration: 1000) layer on {} }'
const development: Compilation = JSON.parse(compile(unicode, true))
assert.deepEqual(development.diagnostics, [])
assert(development.mappings)
const range = development.mappings['a/layer/on/timing'].range
assert.equal(
  Buffer.from(unicode).subarray(range.start, range.end).toString(),
  'tween(duration: 1000)',
)

const shadowed = decodeBundle(
  compile(
    `motion shadowed(easeOut: number) {
  let result = tween + easeOut
  let tween = 2
  let linear = 3
  layer base { z-index: \${result}; order: \${linear} }
}`,
    false,
  ),
).definitions[0]
assert(shadowed.parameters && shadowed.letBindings)
const shadowInputs = parameterValues(shadowed.parameters, targetValues(shadowed), { easeOut: 4 })

const shadowValues = new EvaluationFixture(shadowed.letBindings, shadowInputs).evaluate(
  shadowInputs,
)

assert.deepEqual(
  shadowed.layers[0].targets[0].properties
    .filter(isCssProperty)
    .map((property) => renderProperty(property, shadowValues).value),
  ['6', '3'],
)

const componentDefinition = decodeBundle(
  compile(
    `motion mapped(axis: "x" | "y", input: number) {
  let selected = axis
  let movement = link(input: input, component: (selected))
  layer base { translate := movement }
}`,
    false,
  ),
).definitions[0]
const componentBindings = componentDefinition?.letBindings
assert(componentBindings)

function controllerValue(values: VariableValues) {
  const movement = values.movement
  assert(typeof movement === 'object')

  return movement.value
}

// Direct graph callers bypass host descriptors; invalid components still fail at runtime.
assert.throws(
  () => new EvaluationFixture(componentBindings, { axis: 'z', input: 10 }),
  /link component must be x or y/,
)

for (const sample of [
  { axis: 'x', other: 'y', initial: { x: 10, y: 0, z: 0 }, updated: { x: 20, y: 0, z: 0 } },
  { axis: 'y', other: 'x', initial: { x: 0, y: 10, z: 0 }, updated: { x: 0, y: 20, z: 0 } },
]) {
  const inputs = { axis: sample.axis, input: 10 }
  const graph = new EvaluationFixture(componentBindings, inputs)

  try {
    assert.deepEqual(controllerValue(graph.evaluate(inputs)), sample.initial)

    for (const rejected of [
      { axis: sample.other, message: /link component and input shape are fixed/ },
      { axis: 'z', message: /link component must be x or y/ },
    ]) {
      assert.throws(() => graph.evaluate({ axis: rejected.axis, input: 20 }), rejected.message)

      assert.deepEqual(controllerValue(graph.evaluate(inputs)), sample.initial)
    }

    assert.deepEqual(controllerValue(graph.evaluate({ ...inputs, input: 20 })), sample.updated)
  } finally {
    graph.dispose()
  }
}

const rejectedRoot: Compilation = JSON.parse(
  compile(
    'motion rejected { let self = 1; let ui = interaction(target: self); layer base {} }',
    true,
  ),
)

assert.deepEqual(rejectedRoot.definitions, [])
assert(
  rejectedRoot.diagnostics.some(
    (diagnostic) => diagnostic.message === 'self is a reserved built-in target',
  ),
)

console.log(
  'Node WASM goldens, immutable TS view, schema rejection, UTF-8 mappings, lexical shadowing, and runtime component validation passed',
)

// Object literals cross the real compiler/JSON/runtime boundary, including forward
// dependencies, reactive call indexing, controller attachment and safe own keys.
const objectSource = `motion objects(input: number) {
  let selected = config.property
  let config = {
    property: "value",
    nested: { amount: later * 2 },
    empty: {},
    __proto__: "own",
    constructor: true,
    timing: tween(duration: 100),
    controller: link(input: input),
  }
  let later = input
  let controllerAlias = config.controller
  layer base { opacity := controllerAlias; content: \${selected} }
}`
const objectCompilation: Compilation = JSON.parse(compile(objectSource, false))
assert.deepEqual(objectCompilation.diagnostics, [])
const objectDefinition = decodeBundle(JSON.stringify(objectCompilation)).definitions[0]
assert(objectDefinition.letBindings)
const objectGraph = new EvaluationFixture(objectDefinition.letBindings, { input: 0.25 })
try {
  for (const input of [0.25, 0.75]) {
    const values = objectGraph.evaluate({ input })
    assert.equal(values.selected, 'value')
    assert(typeof values.config === 'object')
    const config = values.config
    assert.deepEqual(config.nested, { amount: input * 2 })
    assert.deepEqual(config.empty, {})
    assert.equal(config.__proto__, 'own')
    assert.equal(config.constructor, true)
    assert.equal(Object.hasOwn(config, '__proto__'), true)
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.nested), true)
    assert(typeof values.controllerAlias === 'object')
    assert.equal(values.controllerAlias.value, input)
  }
} finally {
  objectGraph.dispose()
}
const invalidObjectBundle = structuredClone(objectCompilation)
assert(invalidObjectBundle.definitions[0].letBindings)
Object.assign(invalidObjectBundle.definitions[0].letBindings[0], {
  initializer: {
    kind: 'object',
    properties: [{ name: 'bad', value: { kind: 'unknown' } }],
  },
})
assert.throws(() => decodeBundle(JSON.stringify(invalidObjectBundle)), /schema/)
console.log(
  'Object literal compilation, immutable values, forward dependencies, updates and controllers passed',
)
