import { describe, expect, it } from 'vite-plus/test'
import { compileSfc, diagnosticLocation, hasErrors } from './compiler.ts'
import { applyEdits } from '../wasm/liva_wasm.js'

describe('SFC compiler boundary', () => {
  it('maps UTF-8 diagnostics to SFC lines and UTF-16 columns', () => {
    const motion = 'motion a { layer base { t { x: 1 } /* 日本語😀 */ t { x: 2 } } }'
    const source = `<template><p>日本語😀</p></template>\r\n<liva>\r\n${motion}\r\n</liva>`
    const snapshot = compileSfc(source, 'Unicode.vue', true)
    expect(hasErrors(snapshot)).toBe(true)
    const diagnostic = snapshot.result.diagnostics.find((d) => d.code === 'semantic.duplicate')!
    expect(diagnosticLocation(snapshot, diagnostic)).toEqual({
      line: 3,
      column: motion.lastIndexOf('x: 2'),
    })
    expect(
      Buffer.from(snapshot.block).subarray(diagnostic.range.start, diagnostic.range.end).toString(),
    ).toBe('x')
    expect(snapshot.blockStart).toBe(
      Buffer.byteLength(source.slice(0, source.indexOf('\r\nmotion'))),
    )
  })

  it('rejects multiple and external custom blocks', () => {
    for (const source of [
      '<liva>motion a {}</liva><liva>motion b {}</liva>',
      '<liva src="a.liv"/>',
    ]) {
      expect(() =>
        compileSfc('<template><div /></template>' + source, 'Invalid.vue', false),
      ).toThrow('inline')
    }
  })

  it('keeps production IR separate from development mappings', () => {
    const source =
      '<template><div /></template><liva>motion a { layer on { t { --value: "日本語" } } }</liva>'
    expect(compileSfc(source, 'Valid.vue', false).result.mappings).toBeUndefined()
    expect(compileSfc(source, 'Valid.vue', true).result.mappings).toBeDefined()
  })
})

describe('SFC validation', () => {
  it('rejects malformed Vue markup and missing motion blocks', () => {
    expect(() => compileSfc('<template><div></template>', 'Invalid.vue', false)).toThrow(
      'Invalid Vue SFC',
    )
    expect(() => compileSfc('<template><div /></template>', 'Missing.vue', false)).toThrow('inline')
  })
})

it('reports ambiguous grouped target names at the offending SFC name', () => {
  const motion = 'motion a { layer base { icon, /* 日本😀 */ state { scale: 1 } } }'
  const snapshot = compileSfc(
    `<template><div /></template>\r\n<liva>\r\n${motion}\r\n</liva>`,
    'Grouped.vue',
    true,
  )
  expect(hasErrors(snapshot)).toBe(true)
  const diagnostic = snapshot.result.diagnostics.find((d) => d.code === 'syntax.target-name')!
  expect(diagnostic.message).toContain('rename this target')
  expect(diagnosticLocation(snapshot, diagnostic)).toEqual({
    line: 3,
    column: motion.indexOf('state'),
  })
})

const timing = (target: string, property: string, duration: number) => ({
  op: 'set',
  path: `sample/layer/base/target/${target}/property/${property}/blockTiming`,
  value: `tween(duration: ${duration})`,
})
const apply = (text: string, edits: ReturnType<typeof timing>[]) =>
  JSON.parse(applyEdits(text, JSON.stringify(edits)))

it('preserves ordered writes to shared block decorators through the public WASM API', () => {
  const source =
    'motion sample { layer base { @spring() self, icon { scale: 1; opacity: 1 } self, icon { rotate: 0deg } } }'
  for (const middleTarget of ['self', 'icon']) {
    for (const duration of [20, 50]) {
      const edits = [
        timing('self', 'scale', 20),
        timing(middleTarget, 'opacity', duration),
        timing('icon', 'scale', 20),
      ]
      const batch = apply(source, edits)
      let sequential = source
      for (const edit of edits) sequential = apply(sequential, [edit]).source
      expect(
        compileSfc(`<template><div /></template><liva>${batch.source}</liva>`, 'Batch.vue', false)
          .result.definitions,
      ).toEqual(
        compileSfc(
          `<template><div /></template><liva>${sequential}</liva>`,
          'Sequential.vue',
          false,
        ).result.definitions,
      )
      expect(batch.source).toContain('tween(duration: 20)')
    }
  }
})
