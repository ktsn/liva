import { defineConfig } from '@vizejs/vite-plugin/vite-plus'

export default defineConfig(
  {
    compiler: false,
    pack: {
      entry: ['src/index.ts', 'src/core.ts'],
      unbundle: true,
      format: 'esm',
      platform: 'neutral',
      vue: { tsconfig: 'tsconfig.build.json' },
    },
  },
  { tasks: false },
)
