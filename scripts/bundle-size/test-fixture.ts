import { object } from './data.ts'
import type { Context, Success } from './types.ts'
import { settings } from './model.ts'

export function example(): Success & { context: Context } {
  const measurement = {
    sha: 'a'.repeat(40),
    bytes: { minified: 100, gzip: 80, brotli: 70, definitions: 20 },
    bundle: 'b'.repeat(64),
    metadata: {
      node: settings.node,
      rustc: 'rustc 1.100.0 (test 2026-11-01)',
      wasmBindgen: '0.2.130',
      packageManager: 'pnpm@12.21.0',
      zlib: '1.3',
      brotli: '1.2',
      vite: '8.3.7',
      rolldown: '1.2.18',
      oxc: '0.157.0',
      dependencies: { vue: '3.5.45' },
      lockfile: 'c'.repeat(64),
      cargoLockfile: 'd'.repeat(64),
      wasm: 'e'.repeat(64),
    },
  }

  return {
    schema: 1,
    status: 'success',
    specification: {
      ...structuredClone(settings),
      fixture: 'f'.repeat(64),
      harness: '0'.repeat(64),
    },
    context: {
      repository: 'ktsn/liva',
      pr: 92,
      baseBranch: 'main',
      headRepository: 'fork/liva',
      headBranch: 'feature',
      run: 10000000001,
      attempt: 1,
    },
    base: structuredClone(measurement),
    head: { ...structuredClone(measurement), sha: '1'.repeat(40) },
  }
}

/** Mutate untrusted JSON for rejection tests without pretending it is a valid result. */
export function replaceField(value: unknown, path: string[], replacement: unknown): void {
  const name = path.at(-1)

  if (name === undefined) throw new Error('Expected a nonempty field path')

  const parent = path
    .slice(0, -1)
    .reduce<unknown>((current, key) => fieldContainer(current)[key], value)

  if (Array.isArray(parent)) {
    Reflect.set(parent, name, replacement)
  } else {
    object(parent)[name] = replacement
  }
}

export function readField(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => fieldContainer(current)[key], value)
}

function fieldContainer(value: unknown): { [key: string]: unknown } {
  if (Array.isArray(value)) {
    // JSON arrays expose decimal-index properties; mutation tests also visit settings.external.
    return Object.fromEntries(Object.entries(value))
  }

  return object(value)
}
