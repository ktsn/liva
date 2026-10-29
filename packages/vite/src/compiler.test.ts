import { describe, expect, it } from 'vite-plus/test'
import { compileSfc, diagnosticLocation, hasErrors } from './compiler.ts'

describe('SFC compiler boundary', () => {
  it('maps UTF-8 diagnostics to SFC lines and UTF-16 columns', () => {
    const source =
      '<template><p>日本語😀</p></template>\r\n<liva>\r\na { state on when true { t { x: 1 } } state off { t {} } }\r\n</liva>'
    const snapshot = compileSfc(source, 'Unicode.vue', true)
    expect(hasErrors(snapshot)).toBe(true)
    const diagnostic = snapshot.result.diagnostics.find((d) => d.code === 'semantic.completeness')!
    expect(diagnosticLocation(snapshot, diagnostic)).toEqual({ line: 3, column: 0 })
    expect(snapshot.blockStart).toBe(Buffer.byteLength(source.slice(0, source.indexOf('\r\na'))))
  })

  it('rejects multiple and external custom blocks', () => {
    for (const source of ['<liva>a {}</liva><liva>b {}</liva>', '<liva src="a.liv"/>']) {
      expect(() =>
        compileSfc('<template><div /></template>' + source, 'Invalid.vue', false),
      ).toThrow('inline')
    }
  })

  it('keeps production IR separate from development mappings', () => {
    const source =
      '<template><div /></template><liva>a { state on { t { --value: "日本語" } } }</liva>'
    expect(compileSfc(source, 'Valid.vue', false).result.mappings).toBeUndefined()
    expect(compileSfc(source, 'Valid.vue', true).result.mappings).toBeDefined()
  })
})
