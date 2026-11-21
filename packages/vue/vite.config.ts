import { defineConfig } from '@vizejs/vite-plugin/vite-plus'

export default defineConfig(
  {
    compiler: false,
    pack: {
      entry: ['src/index.ts', 'src/runtime.ts'],
      format: 'esm',
      platform: 'neutral',
      vue: { tsconfig: 'tsconfig.build.json' },
    },
  },
  { tasks: false },
)
