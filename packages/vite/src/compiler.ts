import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { parse } from '@vue/compiler-sfc'
import type { Definition } from '@liva/runtime'

export interface SourceRange {
  start: number
  end: number
}
export interface Diagnostic {
  code: string
  severity: string
  message: string
  range: SourceRange
  related?: SourceRange[]
}
export interface Mapping {
  kind: 'block' | 'value'
  range: SourceRange
}
export interface Compilation {
  schemaVersion: 1
  definitions: Definition[]
  diagnostics: Diagnostic[]
  mappings?: Record<string, Mapping>
}
export interface SourceSnapshot {
  source: string
  block: string
  blockStart: number
  hash: string
  result: Compilation
}

const require = createRequire(import.meta.url)
let wasm:
  | {
      compile(source: string, development: boolean): string
      applyEdits(source: string, edits: string): string
    }
  | undefined

export function compile(source: string, development: boolean): Compilation {
  wasm ??= require('../wasm/liva_wasm.js')
  const result = JSON.parse(wasm!.compile(source, development)) as Compilation

  if (result.schemaVersion !== 1) throw new Error('Unsupported Liva compiler schema')
  return result
}

export function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

export function compileSfc(source: string, filename: string, development: boolean): SourceSnapshot {
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw new Error(`Invalid Vue SFC: ${errors.map(String).join('\n')}`)
  const blocks = descriptor.customBlocks.filter((block) => block.type === 'liva')
  if (blocks.length !== 1 || blocks[0].src)
    throw new Error('Expected exactly one inline <liva> block')
  const block = blocks[0]
  const blockStart = Buffer.byteLength(source.slice(0, block.loc.start.offset))
  return {
    source,
    block: block.content,
    blockStart,
    hash: hash(source),
    result: compile(block.content, development),
  }
}

export function diagnosticLocation(snapshot: SourceSnapshot, diagnostic: Diagnostic) {
  const before = Buffer.from(snapshot.source)
    .subarray(0, snapshot.blockStart + diagnostic.range.start)
    .toString()
  const lines = before.split('\n')
  return { line: lines.length, column: lines.at(-1)!.length }
}

export function hasErrors(snapshot: SourceSnapshot): boolean {
  return snapshot.result.diagnostics.some((d) => d.severity === 'error')
}

export function hasLivaBlock(source: string, filename: string): boolean {
  return parse(source, { filename }).descriptor.customBlocks.some((block) => block.type === 'liva')
}

export function applyEdits(
  source: string,
  edits: unknown,
): { source: string; compilation: Compilation } {
  wasm ??= require('../wasm/liva_wasm.js')
  const result = JSON.parse(wasm!.applyEdits(source, JSON.stringify(edits))) as {
    source: string
    compilation: Compilation
    error?: string
  }
  if (result.error) throw new Error(result.error)
  return result
}
