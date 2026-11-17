import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { specification } from './measure.mjs'

const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** Export committed sources; the harness never writes tracked files in either revision. */
export async function prepareRevision(revision, destination) {
  await mkdir(destination)

  const archive = execFileSync('git', ['archive', revision], { maxBuffer: 50 * 1024 * 1024 })
  const extracted = spawnSync('tar', ['-x', '-C', destination], {
    input: archive,
    stdio: ['pipe', 'inherit', 'inherit'],
  })

  assert.equal(extracted.status, 0, 'Unable to export revision')
  run('pnpm', ['install', '--frozen-lockfile'], destination)
  const manifest = await readFile(join(destination, 'crates/liva_wasm/Cargo.toml'), 'utf8')
  const version = manifest.match(/^wasm-bindgen = "=([0-9.]+)"$/m)?.[1]

  assert(version, 'Unsupported compiler toolchain manifest')

  const installed = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).stdout?.trim()
  let env = process.env

  if (installed !== `wasm-bindgen ${version}`) {
    const toolchain = join(destination, '..', `wasm-bindgen-${version}`)

    if (!existsSync(join(toolchain, 'bin/wasm-bindgen'))) {
      run(
        'cargo',
        ['install', 'wasm-bindgen-cli', '--version', version, '--locked', '--root', toolchain],
        destination,
      )
    }

    env = { ...process.env, PATH: `${join(toolchain, 'bin')}:${process.env.PATH}` }
  }

  run('sh', ['scripts/build-wasm.sh'], destination, env)
}

export async function compare({
  base,
  head,
  baseDirectory,
  headDirectory,
  output,
  context = null,
  prepareSources = false,
  single = false,
}) {
  const result = {
    schema: 1,
    specification: await specification(),
    context,
    base: { sha: base },
    head: { sha: head },
    status: 'success',
  }

  const targets = single
    ? [['head', head, headDirectory]]
    : [
        ['base', base, baseDirectory],
        ['head', head, headDirectory],
      ]

  for (const [side, sha, directory] of targets) {
    try {
      if (prepareSources) await prepareRevision(sha, directory)

      const resultFile = join(directory, '..', `${side}.measurement.json`)
      const workerArgs = [join(import.meta.dirname, 'measure.mjs'), directory, sha, resultFile]

      if (output) workerArgs.push(join(output, side))

      // Fresh processes keep each revision's compiler, native tools and browser client isolated.
      run(process.execPath, workerArgs, process.cwd())
      result[side] = JSON.parse(await readFile(resultFile, 'utf8'))
    } catch (error) {
      result.status = 'failure'
      result[side] = { sha, error: String(error.message).slice(0, 2000) }
      console.error(`${side} (${sha}) measurement failed:`, error)
    }
  }

  if (single) result.base = result.head

  return result
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  assert(
    ['measure', 'compare', 'ci'].includes(command),
    'Usage: node scripts/bundle-size/cli.mjs measure REV OUTPUT | compare BASE HEAD OUTPUT | ci OUTPUT',
  )

  const temporary = await mkdtemp(join(tmpdir(), 'liva-size-revisions-'))
  const output = resolve(
    args[command === 'compare' ? 2 : command === 'measure' ? 1 : 0] || 'bundle-size-results',
  )

  await mkdir(output, { recursive: true })

  try {
    let context = null
    let base
    let head

    if (command === 'ci') {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
      const pr = event.pull_request

      assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request')
      const pins = JSON.parse(
        await readFile(join(process.env.RUNNER_TEMP, 'bundle-size-pins.json'), 'utf8'),
      )

      assert.equal(pins.pr, pr.number)
      assert.equal(pins.baseBranch, pr.base.ref)
      assert.equal(pins.head, pr.head.sha)

      base = git('rev-parse', `${pins.base}^{commit}`)
      head = git('rev-parse', `${pins.head}^{commit}`)
      context = {
        repository: process.env.GITHUB_REPOSITORY,
        pr: pr.number,
        baseBranch: pr.base.ref,
        headRepository: pr.head.repo.full_name,
        headBranch: pr.head.ref,
        run: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      }
    } else {
      base = git('rev-parse', `${args[0]}^{commit}`)
      head = git('rev-parse', `${command === 'measure' ? args[0] : args[1]}^{commit}`)
    }

    const result = await compare({
      base,
      head,
      baseDirectory: join(temporary, 'base'),
      headDirectory: join(temporary, 'head'),
      output,
      context,
      prepareSources: true,
      single: command === 'measure',
    })

    await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))

    if (result.status !== 'success') process.exitCode = 1
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] === import.meta.filename) await main()
