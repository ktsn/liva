import { fileURLToPath } from 'node:url'
import config from '../tsconfig.sources.json' with { type: 'json' }

/** Resolve workspace source entry points without matching sibling package subpaths. */
export const sourceAliases = Object.entries(config.compilerOptions.paths).map(([name, [entry]]) => {
  const wildcard = name.endsWith('/*')
  const pattern = wildcard ? `${name.slice(0, -1)}(.+)` : name

  return {
    find: new RegExp(`^${pattern}$`),
    replacement: fileURLToPath(new URL(entry, new URL('../', import.meta.url))).replace('*', '$1'),
  }
})
