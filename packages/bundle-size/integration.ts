import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compare, prepareRevision } from './cli.ts'
import { measure } from './measure.ts'
import { measured } from './types.ts'
import { validateResult } from './model.ts'

// These source mutations exist only in disposable exported trees, never the checkout.
const temporary = await mkdtemp(join(tmpdir(), 'liva-size-integration-'))
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const target = join(temporary, 'target')
const broken = join(temporary, 'broken')

try {
  await prepareRevision(sha, target)

  const first = await measure(target, sha)
  const repeated = await measure(target, sha)

  assert.deepEqual(first, repeated, 'Same revision must reproduce bytes, hashes and metadata')

  const runtime = join(target, 'packages/runtime/src/index.ts')
  const source = await readFile(runtime, 'utf8')

  await writeFile(
    runtime,
    `${source}\nglobalThis.__bundleSizeVariant = '${'0123456789abcdef'.repeat(64)}';\n`,
  )

  const larger = await measure(target, sha)

  for (const metric of ['minified', 'gzip', 'brotli'] as const)
    assert(larger.bytes[metric] > first.bytes[metric], `${metric} must detect growth`)

  assert.equal(larger.bytes.definitions, first.bytes.definitions)

  await writeFile(runtime, source)

  const smaller = await measure(target, sha)

  assert.deepEqual(smaller.bytes, first.bytes, 'Removing shipped code must restore original sizes')
  assert.equal(smaller.bundle, first.bundle)

  // A real locked build dependency update must use and record that revision's package.
  const replacement =
    first.metadata.dependencies['@vizejs/vite-plugin'] === '0.732.0' ? '0.751.0' : '0.732.0'

  execFileSync(
    'pnpm',
    [
      'add',
      '--workspace-root',
      '--save-dev',
      '--save-exact',
      `@vizejs/vite-plugin@${replacement}`,
      `vize@${replacement}`,
    ],
    { cwd: target, stdio: 'inherit' },
  )

  const dependencyChange = await measure(target, sha)

  assert.equal(dependencyChange.metadata.dependencies['@vizejs/vite-plugin'], replacement)
  assert.notEqual(dependencyChange.metadata.lockfile, first.metadata.lockfile)

  await prepareRevision(sha, broken)
  await writeFile(join(broken, 'packages/runtime/src/index.ts'), 'export const broken = ;')

  for (const side of ['base', 'head'] as const) {
    const result = await compare({
      base: sha,
      head: sha,
      baseDirectory: side === 'base' ? broken : target,
      headDirectory: side === 'head' ? broken : target,
    })

    validateResult(result)
    assert.equal(result.status, 'failure')
    const failed = result[side]
    const succeeded = result[side === 'base' ? 'head' : 'base']

    assert(!measured(failed) && typeof failed.error === 'string')
    assert(measured(succeeded) && succeeded.bytes.minified > 0)
  }

  console.log(
    JSON.stringify(
      {
        first: first.bytes,
        larger: larger.bytes,
        smaller: smaller.bytes,
        dependencyChange: dependencyChange.bytes,
      },
      null,
      2,
    ),
  )
  console.log(
    'Reproducibility, increases, decreases, dependency update and both failure sides passed.',
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
