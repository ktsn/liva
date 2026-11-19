import { afterAll, assert, beforeAll, describe, expect, it } from 'vite-plus/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compare, prepareRevision } from './cli.ts'
import { measured } from './types.ts'
import type { Measurement } from './types.ts'
import { validateResult } from './model.ts'

let temporary: string
let sha: string
let target: string
let broken: string
let baseline: Measurement

// Use the CLI's process isolation for each target's compiler and Playwright client.
async function measurement(directory: string): Promise<Measurement> {
  const result = await compare({
    base: sha,
    head: sha,
    baseDirectory: directory,
    headDirectory: directory,
    single: true,
  })

  expect(result.status).toBe('success')
  assert(measured(result.head))

  return result.head
}

beforeAll(async () => {
  // Every mutation belongs to an exported tree; the checkout and baseline target stay intact.
  temporary = await mkdtemp(join(tmpdir(), 'liva-size-integration-'))
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  target = join(temporary, 'target')
  broken = join(temporary, 'broken')

  await prepareRevision(sha, target)
  baseline = await measurement(target)
  await prepareRevision(sha, broken)
  await writeFile(join(broken, 'packages/runtime/src/index.ts'), 'export const broken = ;')
})

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true })
})

describe('production measurement integration', () => {
  it('reproduces bytes, hashes and metadata for the same revision', async () => {
    expect(await measurement(target)).toStrictEqual(baseline)
  })

  it('detects shipped code growth and restores the original measurement after removal', async () => {
    const runtime = join(target, 'packages/runtime/src/index.ts')
    const source = await readFile(runtime, 'utf8')

    try {
      await writeFile(
        runtime,
        `${source}\nglobalThis.__bundleSizeVariant = '${'0123456789abcdef'.repeat(64)}';\n`,
      )

      const larger = await measurement(target)

      for (const metric of ['minified', 'gzip', 'brotli'] as const) {
        expect(larger.bytes[metric], `${metric} must detect growth`).toBeGreaterThan(
          baseline.bytes[metric],
        )
      }

      expect(larger.bytes.definitions).toBe(baseline.bytes.definitions)
    } finally {
      await writeFile(runtime, source)
    }

    const restored = await measurement(target)

    expect(restored.bytes).toStrictEqual(baseline.bytes)
    expect(restored.bundle).toBe(baseline.bundle)
  })

  it('uses and records a real locked build dependency update', async () => {
    const dependencyTarget = join(temporary, 'dependency')

    await prepareRevision(sha, dependencyTarget)

    const replacement =
      baseline.metadata.dependencies['@vizejs/vite-plugin'] === '0.732.0' ? '0.751.0' : '0.732.0'

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
      { cwd: dependencyTarget, stdio: 'inherit' },
    )

    const changed = await measurement(dependencyTarget)

    expect(changed.metadata.dependencies['@vizejs/vite-plugin']).toBe(replacement)
    expect(changed.metadata.lockfile).not.toBe(baseline.metadata.lockfile)
  })

  it.each(['base', 'head'] as const)(
    'reports a %s build failure while retaining the successful side',
    async (side) => {
      const result = await compare({
        base: sha,
        head: sha,
        baseDirectory: side === 'base' ? broken : target,
        headDirectory: side === 'head' ? broken : target,
      })

      validateResult(result)
      expect(result.status).toBe('failure')

      const failed = result[side]
      const succeeded = result[side === 'base' ? 'head' : 'base']

      expect(measured(failed)).toBe(false)
      expect(failed).toHaveProperty('error', expect.any(String))
      assert(measured(succeeded))
      expect(succeeded.bytes.minified).toBeGreaterThan(0)
    },
  )
})
