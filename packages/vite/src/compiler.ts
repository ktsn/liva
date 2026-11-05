import * as wasm from '../wasm/liva_wasm.js'
import { createHash } from 'node:crypto'
import { parse } from '@vue/compiler-sfc'
import { isArrayOf, isDefinition, isRecord, type Definition } from '@liva/runtime'

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

export function compile(source: string, development: boolean): Compilation {
  const result: unknown = JSON.parse(wasm.compile(source, development))

  /* v8 ignore if -- @preserve: The bundled Rust compiler produces this schema; invalid output requires mocking its ABI. */
  if (!isCompilation(result)) throw new Error('Unsupported Liva compiler schema')
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

export function diagnosticLocation(
  snapshot: Pick<SourceSnapshot, 'source' | 'blockStart'>,
  diagnostic: Diagnostic,
) {
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
  const result: unknown = JSON.parse(wasm.applyEdits(source, JSON.stringify(edits)))
  if (isRecord(result) && typeof result.error === 'string') throw new Error(result.error)
  /* v8 ignore if -- @preserve: Successful Rust edits return source and compilation together by construction. */
  if (
    !isRecord(result) ||
    typeof result.source !== 'string' ||
    !isCompilation(result.compilation)
  ) {
    throw new Error('Invalid Liva edit result')
  }
  return { source: result.source, compilation: result.compilation }
}

/* v8 ignore next -- @preserve: ABI assertions inspect only bundled Rust output, not user input. */
function isRange(value: unknown): value is SourceRange {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number'
}

/* v8 ignore next -- @preserve: ABI assertions inspect only bundled Rust output, not user input. */
function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.message === 'string' &&
    isRange(value.range) &&
    (value.related === undefined || isArrayOf(value.related, isRange))
  )
}

/* v8 ignore next -- @preserve: ABI assertions inspect only bundled Rust output, not user input. */
function isMapping(value: unknown): value is Mapping {
  return (
    isRecord(value) && (value.kind === 'block' || value.kind === 'value') && isRange(value.range)
  )
}

/* v8 ignore next -- @preserve: ABI assertions inspect only bundled Rust output, not user input. */
function isCompilation(value: unknown): value is Compilation {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isArrayOf(value.definitions, isDefinition) &&
    isArrayOf(value.diagnostics, isDiagnostic) &&
    (value.mappings === undefined ||
      (isRecord(value.mappings) && Object.values(value.mappings).every(isMapping)))
  )
}
