import { settings } from './model.mjs'

export function example() {
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
