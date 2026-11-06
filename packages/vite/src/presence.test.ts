import { expect, it } from 'vite-plus/test'
import { compileSfc } from './compiler.ts'
import { planPresence, PresenceError } from './presence.ts'

const block = `<liva>
motion panel {
  state idle { body { opacity: 1 } other { opacity: 1 } }
  enter { @tween: 100ms; body { opacity { 0%: 0 } } }
  leave { @tween: 200ms; body { opacity { 100%: 0 } } other { opacity { 100%: 0 } } }
}
</liva>`

function plan(template: string) {
  const source = `<template>${template}</template>${block}`
  return planPresence(
    source,
    'Panel.vue',
    compileSfc(source, 'Panel.vue', false).result.definitions,
  )
}

it('deduplicates shared boundaries and plans each nested structural operation', () => {
  const result = plan(`<div v-liva:panel>
    <section v-if="visible"><article v-for="item in items" :key="item.id">
      <div v-liva-target:body /><span v-liva-target:other />
    </article></section>
  </div>`)

  expect(result.boundaries.map((boundary) => boundary.operation)).toEqual(['if', 'for'])
  expect(result.boundaries.map((boundary) => boundary.targets.length)).toEqual([2, 2])
  expect(result.code.match(/<LivaPresenceBoundary /g)).toHaveLength(2)
  expect(result.code).toContain(':key="item.id"')
  expect(result.code).toContain('livaBoundary1.item(item.id)')
  expect(result.map.sources).toEqual(['Panel.vue'])
})

it('wraps the whole conditional chain while retaining listeners and authored keys', () => {
  const result = plan(`<div v-liva:panel>
    <div v-if="a" key="a" v-liva-target:body @click="act" />
    <!-- branch -->
    <div v-else-if="b" key="b" v-liva-target:body />
    <div v-else key="c" v-liva-target:body />
  </div>`)

  expect(result.boundaries).toHaveLength(1)
  expect(result.code.match(/<LivaPresenceBoundary /g)).toHaveLength(1)
  expect(result.code).toContain('@click="act"')
  expect(result.code).toContain('key="a"')
  expect(result.code.indexOf('</LivaPresenceBoundary>')).toBeGreaterThan(
    result.code.indexOf('v-else key="c"'),
  )
})

it.each(['Transition', 'TransitionGroup', 'transition', 'transition-group'])(
  'rejects lifecycle ownership by user %s with a source location',
  (component) => {
    let caught: unknown
    try {
      plan(
        `<div v-liva:panel>\n<${component}><div v-if="visible" v-liva-target:body /></${component}></div>`,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(PresenceError)
    if (!(caught instanceof PresenceError)) throw new Error('Expected conflict')
    expect(caught.message).toContain('Remove the Vue Transition')
    expect(caught.loc.line).toBe(2)
  },
)

it('leaves unrelated Transitions unchanged', () => {
  const transition = '<Transition name="fade"><div v-if="unrelated">Other</div></Transition>'
  const result = plan(
    `<div v-liva:panel>${transition}<section v-show="shown"><div v-liva-target:body /></section></div>`,
  )

  expect(result.code).toContain(transition)
  expect(result.boundaries[0].strategy).toBe('persisted Transition')
})

it.each([
  ['<div v-for="item in items" v-liva-target:body />', 'explicit :key'],
  ['<template v-if="visible"><div v-liva-target:body /></template>', 'native structural element'],
  ['<div v-if="visible" v-show="shown" v-liva-target:body />', 'Separate combined'],
  [
    '<section v-if="visible"><Child><div v-liva-target:body /></Child></section>',
    'across a child component',
  ],
])('diagnoses unsupported structure %s', (template, message) => {
  expect(() => plan(`<div v-liva:panel>${template}</div>`)).toThrow(message)
})

it('does not resolve targets across a nested Motion root', () => {
  const result = plan(
    '<div v-liva:panel><div v-liva:panel><span v-if="ok" v-liva-target:body /></div></div>',
  )
  expect(result.code).toContain('owner: [1]')
  expect(result.code).not.toContain('owner: [0]')
})

it.each([
  ['', 'undefined'],
  ['=""', 'undefined'],
  ['="state"', 'state'],
  ["='{ value: 1, owner: 2, entries: 3 }'", '{ value: 1, owner: 2, entries: 3 }'],
  ['="readParameters()"', 'readParameters()'],
])('wraps authored Motion values without changing their expressions: %s', (binding, value) => {
  const result = plan(`<div v-liva:panel${binding} v-liva-target:body />`)

  expect(result.code).toContain(`v-liva:panel.compiled="{ value: (${value}), owner: [0] }"`)
  expect(result.code).toContain('v-liva-target:body.compiled=')
  expect(result.code).toContain('v-liva-entry=')
  expect(result.code).not.toMatch(/v-liva-(owner|lifecycle)/)
  expect(result.code.split(`value: (${value})`).length - 1).toBe(value === 'undefined' ? 2 : 1)
})

it('preserves modifiers and escapes expressions in generated bindings', () => {
  const result = plan(`<div v-liva:panel.custom="state === &quot;idle&quot; ? state : 'idle'">
    <span v-liva-target:body.custom="readTarget()" />
  </div>`)

  expect(result.code).toContain('v-liva:panel.custom.compiled=')
  expect(result.code).toContain('state === &quot;idle&quot;')
  expect(result.code).toContain('v-liva-target:body.custom.compiled="{ value: (readTarget()),')
})

it('plans targets declared only by motion-level lifecycles', () => {
  const source = `<template><div v-liva:panel><span v-if="visible" v-liva-target:body /></div></template>
  <liva>motion panel { state idle { body { opacity: 1 } } enter { @tween: 10ms; body { opacity: 0 } } leave { @tween: 10ms; body { opacity: 0 } } }</liva>`
  const result = planPresence(
    source,
    'Panel.vue',
    compileSfc(source, 'Panel.vue', false).result.definitions,
  )

  expect(result.boundaries).toHaveLength(1)
  expect(result.boundaries[0].targets).toEqual([
    { motion: 'panel', target: 'body', enter: true, leave: true },
  ])
  expect(result.code).toContain('v-liva-target:body.compiled=')
})

it.each([
  ['<div v-liva="value"><span v-liva-target:body /></div>', 'static Motion'],
  ['<div v-liva:panel><span v-liva-target="value" /></div>', 'static target'],
  ['<Panel v-liva:panel><span v-liva-target:body /></Panel>', 'native elements'],
  ['<div v-liva:panel><Panel v-liva-target:body /></div>', 'native elements'],
  ['<div v-for="item in items" v-liva:panel><span v-liva-target:body /></div>', 'explicit :key'],
])('rejects unsupported lifecycle ownership: %s', (template, message) => {
  expect(() => plan(template)).toThrow(message)
})

it('keeps unowned targets and non-lifecycle targets unchanged', () => {
  const result = plan(
    '<div v-liva-target:body /><div v-liva:unknown><span v-liva-target:body /></div><div v-liva:panel><span v-liva-target:unrelated /></div>',
  )

  expect(result.boundaries).toEqual([])
})

it('keys repeated motion owners independently from their nested presence boundaries', () => {
  const result = plan(
    '<div v-for="item in items" :key="item.id" v-liva:panel><span v-if="item.visible" v-liva-target:body /></div>',
  )

  expect(result.code).toContain('owner: [0, item.id]')
  expect(result.boundaries.length).toBeGreaterThan(0)
})

it('accepts dynamic target arguments when no lifecycle requires ownership', () => {
  const source = '<template><div v-liva:plain><span v-liva-target="target" /></div></template>'

  expect(
    planPresence(source, 'Plain.vue', [{ name: 'plain', states: [], directionalTransitions: [] }])
      .code,
  ).toBe(source)
  expect(planPresence('<script>export default {}</script>', 'Script.vue', []).boundaries).toEqual(
    [],
  )
})

it('finds native lifecycle owners through non-transition component slots', () => {
  const result = plan(
    '<div v-liva:panel><Wrapper><section v-if="visible" v-liva-target:body /></Wrapper></div>',
  )

  expect(result.boundaries).toHaveLength(1)
  expect(result.code).toContain('<LivaPresenceBoundary')
})
