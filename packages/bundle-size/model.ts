import assert from 'node:assert/strict'
import { number, object, text } from './data.ts'
import {
  measured,
  type Bytes,
  type Comparison,
  type Context,
  type Measurement,
  type Metadata,
  type Provenance,
  type SideResult,
  type Specification,
} from './types.ts'

export const settings = Object.freeze({
  version: 1,
  node: '26.13.1',
  format: 'es',
  target: 'es2023',
  minifier: 'oxc',
  sourcemap: false,
  gzipLevel: 9,
  brotliQuality: 11,
  external: Object.freeze(['vue']),
})
export const marker = '<!-- liva-bundle-size:v1 -->'
export const metrics: Record<keyof Bytes, string> = {
  minified: 'Minified JS',
  gzip: 'gzip JS',
  brotli: 'Brotli JS',
  definitions: 'Definition JSON (UTF-8)',
}
export const metricNames = ['minified', 'gzip', 'brotli', 'definitions'] as const
export const sideNames = ['base', 'head'] as const
const sha = /^[a-f0-9]{40}$/
const hash = /^[a-f0-9]{64}$/
const safe = /^[A-Za-z0-9@._+/-]{1,200}$/
const matchesString = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value)
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000

function keys(value: unknown, names: string[]): Record<string, unknown> {
  const record = object(value)

  assert.deepEqual(
    Object.keys(record).toSorted((a, b) => a.localeCompare(b)),
    names.toSorted((a, b) => a.localeCompare(b)),
    'Unexpected schema fields',
  )

  return record
}

/** Decode a measurement only after checking every field of the untrusted payload. */
export function validateMeasurement(value: unknown): Measurement {
  const result = keys(value, ['sha', 'bytes', 'bundle', 'metadata'])
  const bytes = keys(result.bytes, Object.keys(metrics))

  for (const bytesValue of Object.values(bytes)) assert(integer(bytesValue))

  const metadata = keys(result.metadata, [
    'node',
    'rustc',
    'wasmBindgen',
    'packageManager',
    'zlib',
    'brotli',
    'vite',
    'rolldown',
    'oxc',
    'dependencies',
    'lockfile',
    'cargoLockfile',
    'wasm',
  ])

  assert.equal(metadata.node, settings.node)
  assert(matchesString(metadata.rustc, /^rustc [A-Za-z0-9 .()+-]{1,150}$/))

  for (const name of ['wasmBindgen', 'packageManager', 'zlib', 'brotli', 'vite', 'rolldown', 'oxc'])
    assert(matchesString(metadata[name], safe))
  for (const name of ['lockfile', 'cargoLockfile', 'wasm'])
    assert(matchesString(metadata[name], hash))

  const dependencies = object(metadata.dependencies)
  assert(Object.keys(dependencies).length > 0 && Object.keys(dependencies).length <= 100)

  const decodedDependencies = Object.fromEntries(
    Object.entries(dependencies).map(([name, version]): [string, string] => {
      assert(safe.test(name) && matchesString(version, safe))

      return [name, text(version)]
    }),
  )

  assert(matchesString(result.sha, sha) && matchesString(result.bundle, hash))

  const decodedMetadata: Metadata = {
    node: text(metadata.node),
    rustc: text(metadata.rustc),
    wasmBindgen: text(metadata.wasmBindgen),
    packageManager: text(metadata.packageManager),
    zlib: text(metadata.zlib),
    brotli: text(metadata.brotli),
    vite: text(metadata.vite),
    rolldown: text(metadata.rolldown),
    oxc: text(metadata.oxc),
    dependencies: decodedDependencies,
    lockfile: text(metadata.lockfile),
    cargoLockfile: text(metadata.cargoLockfile),
    wasm: text(metadata.wasm),
  }

  return {
    sha: text(result.sha),
    bundle: text(result.bundle),
    bytes: {
      minified: positiveBytes(bytes.minified),
      gzip: positiveBytes(bytes.gzip),
      brotli: positiveBytes(bytes.brotli),
      definitions: positiveBytes(bytes.definitions),
    },
    metadata: decodedMetadata,
  }
}

function positiveBytes(value: unknown): number {
  assert(integer(value))

  return value
}

function decodeSide(value: unknown): SideResult {
  const result = object(value)

  assert(matchesString(result.sha, sha))

  if ('error' in result) {
    keys(result, ['sha', 'error'])
    assert(typeof result.error === 'string' && result.error.length <= 2000)

    return { sha: text(result.sha), error: result.error }
  }

  return validateMeasurement(result)
}

/** Validate every artifact field before it reaches a privileged formatter or API call. */
export function validateResult(value: unknown): Comparison {
  const result = keys(value, ['schema', 'status', 'specification', 'context', 'base', 'head'])

  assert.equal(result.schema, 1)
  assert(result.status === 'success' || result.status === 'failure')

  const spec = keys(result.specification, [...Object.keys(settings), 'fixture', 'harness'])

  for (const [name, expected] of Object.entries(settings)) assert.deepEqual(spec[name], expected)
  assert(matchesString(spec.fixture, hash) && matchesString(spec.harness, hash))

  const specification: Specification = {
    ...settings,
    fixture: text(spec.fixture),
    harness: text(spec.harness),
  }
  let context: Context | null = null

  if (result.context !== null) {
    const raw = keys(result.context, [
      'repository',
      'pr',
      'baseBranch',
      'headRepository',
      'headBranch',
      'run',
      'attempt',
    ])

    for (const name of ['repository', 'baseBranch', 'headRepository', 'headBranch']) {
      const field = text(raw[name])

      assert(
        field.length > 0 &&
          field.length <= 250 &&
          Array.from(field).every(
            (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
          ),
      )
    }

    context = {
      repository: text(raw.repository),
      pr: number(raw.pr),
      baseBranch: text(raw.baseBranch),
      headRepository: text(raw.headRepository),
      headBranch: text(raw.headBranch),
      run: number(raw.run),
      attempt: number(raw.attempt),
    }
  }

  const base = decodeSide(result.base)
  const head = decodeSide(result.head)
  const common = { schema: 1 as const, specification, context }

  if (measured(base) && measured(head)) {
    assert.equal(result.status, 'success')

    return { ...common, status: 'success', base, head }
  }

  assert.equal(result.status, 'failure')

  return { ...common, status: 'failure', base, head }
}

export function difference(base: number, head: number) {
  return { bytes: head - base, percent: base === 0 ? null : ((head - base) / base) * 100 }
}

export function formatComment(result: Comparison | null, provenance: Provenance) {
  const logs = `https://github.com/${provenance.repository}/actions/runs/${provenance.run}/attempts/${provenance.attempt}`
  const lines = [
    marker,
    `<!-- run:${provenance.run} attempt:${provenance.attempt} -->`,
    '### Production bundle size',
    '',
  ]

  if (result?.status === 'success') {
    lines.push(
      '| Metric | Base bytes | PR bytes | Difference | Change |',
      '| --- | ---: | ---: | ---: | ---: |',
    )

    for (const key of metricNames) {
      const label = metrics[key]
      const base = result.base.bytes[key]
      const head = result.head.bytes[key]
      const delta = difference(base, head)

      lines.push(
        `| ${label} | ${base} | ${head} | ${delta.bytes >= 0 ? '+' : ''}${delta.bytes} | ${delta.percent === null ? 'n/a' : `${delta.percent >= 0 ? '+' : ''}${delta.percent.toFixed(2)}%`} |`,
      )
    }
  } else {
    const failures = result
      ? sideNames
          .filter((side) => !measured(result[side]))
          .map((side) => `${side} \`${result[side].sha}\``)
          .join(', ')
      : 'setup or artifact publication'

    lines.push(
      `**Measurement failed:** ${failures}. See the workflow logs. Earlier size results are superseded.`,
    )
  }

  lines.push(
    '',
    `Base: \`${result?.base.sha || provenance.baseSha}\` · PR: \`${provenance.headSha}\``,
    `[Workflow logs](${logs})`,
  )

  if (result) {
    const details = {
      specification: result.specification,
      base: measured(result.base) ? result.base.metadata : undefined,
      head: measured(result.head) ? result.head.metadata : undefined,
    }

    lines.push(
      '',
      '<details><summary>Measurement conditions</summary>',
      '',
      '```json',
      JSON.stringify(details, null, 2),
      '```',
      '',
      '</details>',
    )
  }

  return lines.join('\n')
}
