import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile } from '../packages/vite/wasm/liva_wasm.js'
import type { Compilation } from '../packages/vite/src/compiler.ts'
import { decodeBundle } from '../packages/runtime/src/model/definition.ts'
import {
  LetBindingGraph,
  parameterValues,
  targetValues,
} from '../packages/runtime/src/evaluation/let-bindings.ts'
import {
  renderProperty,
  type VariableValues,
} from '../packages/runtime/src/evaluation/expression.ts'

for (const name of [
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

const shadowValues = new LetBindingGraph(shadowed.letBindings, shadowInputs).evaluate(shadowInputs)

assert.deepEqual(
  shadowed.layers[0].targets[0].properties.map(
    (property) => renderProperty(property, shadowValues).value,
  ),
  ['6', '3'],
)

const componentDefinition = decodeBundle(
  compile(
    `motion mapped(axis: string, input: number) {
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

assert.throws(
  () => new LetBindingGraph(componentBindings, { axis: 'z', input: 10 }),
  /link component must be x or y/,
)

for (const sample of [
  { axis: 'x', other: 'y', initial: { x: 10, y: 0, z: 0 }, updated: { x: 20, y: 0, z: 0 } },
  { axis: 'y', other: 'x', initial: { x: 0, y: 10, z: 0 }, updated: { x: 0, y: 20, z: 0 } },
]) {
  const inputs = { axis: sample.axis, input: 10 }
  const graph = new LetBindingGraph(componentBindings, inputs)

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
