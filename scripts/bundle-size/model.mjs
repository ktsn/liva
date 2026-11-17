import assert from 'node:assert/strict'

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
export const metrics = {
  minified: 'Minified JS',
  gzip: 'gzip JS',
  brotli: 'Brotli JS',
  definitions: 'Definition JSON (UTF-8)',
}
const sha = /^[a-f0-9]{40}$/
const hash = /^[a-f0-9]{64}$/
const safe = /^[A-Za-z0-9@._+/-]{1,200}$/
const matchesString = (value, pattern) => typeof value === 'string' && pattern.test(value)
const integer = (value) => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000

function keys(value, names) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  assert.deepEqual(
    Object.keys(value).toSorted((a, b) => a.localeCompare(b)),
    [...names].toSorted((a, b) => a.localeCompare(b)),
    'Unexpected schema fields',
  )
}

/** Validate every artifact field before it reaches a privileged formatter or API call. */
export function validateResult(value) {
  keys(value, ['schema', 'status', 'specification', 'context', 'base', 'head'])
  assert.equal(value.schema, 1)
  assert(['success', 'failure'].includes(value.status))
  keys(value.specification, [...Object.keys(settings), 'fixture', 'harness'])

  for (const [name, expected] of Object.entries(settings))
    assert.deepEqual(value.specification[name], expected)
  assert(
    matchesString(value.specification.fixture, hash) &&
      matchesString(value.specification.harness, hash),
  )

  if (value.context !== null) {
    keys(value.context, [
      'repository',
      'pr',
      'baseBranch',
      'headRepository',
      'headBranch',
      'run',
      'attempt',
    ])

    for (const name of ['pr', 'run', 'attempt'])
      assert(Number.isSafeInteger(value.context[name]) && value.context[name] > 0)
    for (const name of ['repository', 'baseBranch', 'headRepository', 'headBranch']) {
      assert(
        typeof value.context[name] === 'string' &&
          value.context[name].length > 0 &&
          value.context[name].length <= 250 &&
          Array.from(value.context[name]).every(
            (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
          ),
      )
    }
  }

  let failures = 0

  for (const side of ['base', 'head']) {
    const result = value[side]

    assert(matchesString(result?.sha, sha))

    if ('error' in result) {
      keys(result, ['sha', 'error'])
      assert(typeof result.error === 'string' && result.error.length <= 2000)
      failures++
      continue
    }

    keys(result, ['sha', 'bytes', 'bundle', 'metadata'])
    keys(result.bytes, Object.keys(metrics))

    for (const bytes of Object.values(result.bytes)) assert(integer(bytes))

    assert(matchesString(result.bundle, hash))
    keys(result.metadata, [
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
    assert.equal(result.metadata.node, settings.node)
    assert(matchesString(result.metadata.rustc, /^rustc [A-Za-z0-9 .()+-]{1,150}$/))
    for (const name of [
      'wasmBindgen',
      'packageManager',
      'zlib',
      'brotli',
      'vite',
      'rolldown',
      'oxc',
    ])
      assert(matchesString(result.metadata[name], safe))
    for (const name of ['lockfile', 'cargoLockfile', 'wasm'])
      assert(matchesString(result.metadata[name], hash))

    const dependencies = result.metadata.dependencies

    assert(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies))
    assert(Object.keys(dependencies).length > 0 && Object.keys(dependencies).length <= 100)

    for (const [name, version] of Object.entries(dependencies))
      assert(safe.test(name) && matchesString(version, safe))
  }

  assert.equal(value.status === 'failure', failures > 0)

  return value
}

export function difference(base, head) {
  return { bytes: head - base, percent: base === 0 ? null : ((head - base) / base) * 100 }
}

export function formatComment(result, provenance) {
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

    for (const [key, label] of Object.entries(metrics)) {
      const base = result.base.bytes[key]
      const head = result.head.bytes[key]
      const delta = difference(base, head)

      lines.push(
        `| ${label} | ${base} | ${head} | ${delta.bytes >= 0 ? '+' : ''}${delta.bytes} | ${delta.percent === null ? 'n/a' : `${delta.percent >= 0 ? '+' : ''}${delta.percent.toFixed(2)}%`} |`,
      )
    }
  } else {
    const failures = result
      ? ['base', 'head']
          .filter((side) => result[side].error)
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
      base: result.base.metadata,
      head: result.head.metadata,
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
