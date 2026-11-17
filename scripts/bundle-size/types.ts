import type { settings } from './model.ts'

/** Metrics are UTF-8/compressed byte counts. Context.run is the GitHub run ID;
 * attempts distinguish reruns of that same ID. Source and content hashes are hex strings. */
export type Metric = 'minified' | 'gzip' | 'brotli' | 'definitions'
export type Bytes = Record<Metric, number>
export type Side = 'base' | 'head'
export type Specification = typeof settings & { fixture: string; harness: string }
export interface Context {
  repository: string
  pr: number
  baseBranch: string
  headRepository: string
  headBranch: string
  run: number
  attempt: number
}
export interface Metadata {
  node: string
  rustc: string
  wasmBindgen: string
  packageManager: string
  zlib: string
  brotli: string
  vite: string
  rolldown: string
  oxc: string
  dependencies: Record<string, string>
  lockfile: string
  cargoLockfile: string
  wasm: string
}
export interface Measurement {
  sha: string
  bytes: Bytes
  bundle: string
  metadata: Metadata
}
export interface Failure {
  sha: string
  error: string
}
export type SideResult = Measurement | Failure
interface CommonResult {
  schema: 1
  specification: Specification
  context: Context | null
}
export interface Success extends CommonResult {
  status: 'success'
  base: Measurement
  head: Measurement
}
export interface Failed extends CommonResult {
  status: 'failure'
  base: SideResult
  head: SideResult
}
export type Comparison = Success | Failed
export interface Provenance {
  repository: string
  run: number
  attempt: number
  headSha: string
  baseSha?: string
}

export function measured(side: SideResult): side is Measurement {
  return 'bytes' in side
}
