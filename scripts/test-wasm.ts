import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile } from '../packages/vite/wasm/liva_wasm.js'
import type { Compilation } from '../packages/vite/src/compiler.ts'
import { decodeBundle } from '../packages/runtime/src/definition.ts'
import {
  LetBindingGraph,
  parameterValues,
  targetValues,
} from '../packages/runtime/src/let-bindings.ts'
import { renderValue } from '../packages/runtime/src/expression.ts'

for (const name of [
  'toggle',
  'self-target',
  'reactive-toggle',
  'card',
  'derived',
  'presence',
  'lifecycle',
  'interaction',
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
assert.throws(() => decodeBundle('{"schemaVersion":2,"definitions":[]}'), /Unsupported/)

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
  shadowed.layers[0].targets[0].properties.map((property) => renderValue(property, shadowValues)),
  ['6', '3'],
)

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
  'Node WASM golden contract, immutable TS view, schema rejection, UTF-8 mappings, and lexical shadowing passed',
)
