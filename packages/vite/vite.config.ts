import { defineConfig } from '@vizejs/vite-plugin/vite-plus'

export default defineConfig(
  {
    pack: {
      entry: ['src/index.ts'],
      tsconfig: 'tsconfig.build.json',
      format: 'esm',
      fixedExtension: false,
      deps: { neverBundle: ['../wasm/liva_wasm.js'] },
      vue: { tsconfig: 'tsconfig.build.json' },
    },
    publicDir: false,
    build: {
      // The Vite Vue transform embeds custom-element styles in the shadow root.
      emptyOutDir: false,
      lib: {
        entry: 'src/editor/client.ts',
        formats: ['es'],
        fileName: () => 'editor.js',
      },
      rolldownOptions: {
        external: ['vue', /^@liva\/(runtime|vue)(\/|$)/],
      },
    },
  },
  { tasks: false },
)
