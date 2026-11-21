import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vitePlusConfig } from '@vizejs/vite-plugin/vite-plus'
import { build } from 'vite-plus'

const packages = resolve(import.meta.dirname, '../packages')
const tsc = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')))

// Emit modules in dependency order so downstream declarations resolve through package exports.
for (const name of ['runtime', 'vue', 'vite']) {
  const directory = resolve(packages, name)
  await rm(resolve(directory, 'dist'), { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: directory,
    stdio: 'inherit',
  })
}

const editor = await vitePlusConfig({
  root: resolve(packages, 'vite'),
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/editor/client.ts',
      formats: ['es'],
      fileName: () => 'editor.js',
    },
    rolldownOptions: {
      external: ['vue', '@liva/runtime', '@liva/vue/runtime'],
    },
  },
})

await build({ ...editor, configFile: false })
