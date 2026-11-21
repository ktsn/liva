import { MagicString } from '@vue/compiler-sfc'
import type { Plugin, Rollup } from 'vite-plus'

type Parse = Rollup.TransformPluginContext['parse']
type Expression = Extract<
  ReturnType<Parse>['body'][number],
  { type: 'ExpressionStatement' }
>['expression']
type Identifier = Extract<Expression, { type: 'Identifier' }>
type DynamicImport = Extract<Expression, { type: 'ImportExpression' }>

function isNode<T extends { type: string }>(node: object, type: T['type']): node is T {
  return 'type' in node && node.type === type
}

export const presenceReference = 'liva:internal-presence-boundary'

/**
 * Binds a compiler-generated component reference after Vue has resolved all
 * authored script and template scopes. A reserved dynamic import is the marker
 * shared by the Vue SFC compiler and Vize, including their template-only HMR.
 */
export function linkPresenceReference(code: string, id: string, parse: Parse) {
  const identifiers = new Set<string>()
  const references: { start: number; end: number }[] = []
  const pending: unknown[] = [parse(code)]

  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue

    if (isNode<Identifier>(node, 'Identifier')) identifiers.add(node.name)

    if (
      isNode<DynamicImport>(node, 'ImportExpression') &&
      node.source.type === 'Literal' &&
      node.source.value === presenceReference
    ) {
      references.push({ start: node.start, end: node.end })
    }

    for (const child of Object.values(node)) pending.push(child)
  }

  if (!references.length) return undefined

  let binding = 'livaPresenceBoundary'
  while (identifiers.has(binding)) binding += '_'

  const output = new MagicString(code)
  output.append(`\nimport { LivaPresenceBoundary as ${binding} } from 'liva:vue/presence';\n`)

  for (const { start, end } of references) output.overwrite(start, end, binding)

  return { code: output.toString(), map: output.generateMap({ source: id, hires: true }) }
}

export const presenceReferencePlugin: Plugin = {
  name: 'liva:presence-reference',
  enforce: 'post',
  transform(code, id) {
    const [file, query = ''] = id.split('?', 2)
    const type = new URLSearchParams(query).get('type')

    if (file.endsWith('.vue') && (!type || type === 'template') && code.includes(presenceReference))
      return linkPresenceReference(code, id, (source) => this.parse(source))

    return undefined
  },
}
