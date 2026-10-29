import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { chromium, type Browser } from '@playwright/test'

const cwd = resolve(import.meta.dirname, '../playground')
const base = 'http://127.0.0.1:4181'

async function inspect(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) {
      await inspect(path)
      continue
    }
    assert(!/\.(wasm|map)$/.test(path), `Unexpected compiler/map artifact: ${path}`)
    const content = await readFile(path, 'utf8')
    for (const marker of [
      '__LIVA_EDITOR__',
      '/__liva/editor',
      'livaSource',
      'X-Liva-Session',
      'Motion editor',
      'applyEdits',
      'wasm_bindgen',
      'sourceId',
      'mappings',
      resolve(cwd, '..'),
    ]) {
      assert(!content.includes(marker), `Production output contains ${marker}`)
    }
  }
}

for (const mode of ['production', 'development']) {
  execFileSync('vp', ['build', '--mode', mode], { cwd, stdio: 'inherit' })
  await inspect(resolve(cwd, 'dist'))
  const server = spawn('vp', ['preview', '--host', '127.0.0.1', '--port', '4181', '--strictPort'], {
    cwd,
    stdio: 'pipe',
    detached: true,
  })
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk
  })
  server.stderr.on('data', (chunk) => {
    output += chunk
  })
  let browser: Browser | undefined
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(output)
      try {
        ready = stripVTControlCharacters(output).includes(base) && (await fetch(base)).ok
      } catch {
        /* Wait for the preview listener. */
      }
      if (ready) break
      await new Promise((done) => setTimeout(done, 100))
    }
    assert(ready, `Preview did not start: ${output}`)
    const response = await fetch(`${base}/__liva/editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert(response.status >= 400, `Editor route accepted POST: ${response.status}`)
    browser = await chromium.launch()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    assert.equal(await page.locator('[data-liva-editor]').count(), 0)
    assert.equal(await page.evaluate(() => '__LIVA_EDITOR__' in window), false)
    const toggle = page.getByRole('switch', { name: 'Notifications' })
    await toggle.click()
    await page.waitForFunction(() => {
      const thumb = document.querySelector('.thumb')
      return (
        thumb &&
        parseFloat(getComputedStyle(thumb).translate) === 24 &&
        document.getAnimations().length === 0
      )
    })
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.deepEqual(errors, [])
    console.log(`Production isolation and playback passed (${mode} mode).`)
  } finally {
    await browser?.close()
    const stopped = new Promise<void>((done) => server.once('exit', done))
    if (server.exitCode === null && server.pid !== undefined) {
      process.kill(-server.pid, 'SIGTERM')
      await stopped
    }
  }
}
