import { MagicString } from '@vue/compiler-sfc'
import type { Plugin, Rollup } from 'vite-plus'

type Parse = Rollup.TransformPluginContext['parse']
type Expression = Extract<
  ReturnType<Parse>['body'][number],
  { type: 'ExpressionStatement' }
>['expression']
type Identifier = Extract<Expression, { type: 'Identifier' }>
type DynamicImport = Extract<Expression, { type: 'ImportExpression' }>
type ArrayExpression = Extract<Expression, { type: 'ArrayExpression' }>
type CallExpression = Extract<Expression, { type: 'CallExpression' }>
type DirectiveOperand = ArrayExpression['elements'][number] | CallExpression['arguments'][number]
type Span = { start: number; end: number }

const referencePrefix = 'liva:internal-presence-'
export const presenceBoundaryReference = referencePrefix + 'boundary'
export const presenceEntryReference = referencePrefix + 'entry'

function isNode<T extends { type: string }>(node: object, type: T['type']): node is T {
  return 'type' in node && node.type === type
}

function importsReference(node: object, specifier: string): node is DynamicImport {
  return (
    isNode<DynamicImport>(node, 'ImportExpression') &&
    node.source.type === 'Literal' &&
    node.source.value === specifier
  )
}

/** Finds compiled render placeholders and binds them outside all authored Vue scopes. */
function linkPresenceReferences(code: string, id: string, parse: Parse) {
  const identifiers = new Set<string>()
  const boundaries: Span[] = []
  const entries: { directive: Span; call: Span; entry: Span }[] = []
  const pending: unknown[] = [parse(code)]

  const recordEntry = (
    directive: DirectiveOperand | undefined,
    value: DirectiveOperand | undefined,
  ) => {
    if (
      directive &&
      value?.type === 'CallExpression' &&
      importsReference(value.callee, presenceEntryReference)
    ) {
      // The planner passes exactly one entry expression to the private marker.
      entries.push({ directive, call: value, entry: value.arguments[0] })
    }
  }

  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue

    if (isNode<Identifier>(node, 'Identifier')) identifiers.add(node.name)

    if (importsReference(node, presenceBoundaryReference)) boundaries.push(node)

    // Client render functions emit directive tuples. Vue's SSR renderer can
    // also pass the same directive and value after its render context argument.
    if (isNode<ArrayExpression>(node, 'ArrayExpression'))
      recordEntry(node.elements[0], node.elements[1])
    if (isNode<CallExpression>(node, 'CallExpression'))
      recordEntry(node.arguments[1], node.arguments[2])

    for (const child of Object.values(node)) pending.push(child)
  }

  if (!boundaries.length && !entries.length) return undefined

  const output = new MagicString(code)
  const imports: string[] = []
  const bind = (exportName: string, base: string) => {
    let binding = base
    while (identifiers.has(binding)) binding += '_'

    imports.push(`${exportName} as ${binding}`)

    return binding
  }

  if (boundaries.length) {
    const binding = bind('LivaPresenceBoundary', 'livaPresenceBoundary')

    for (const { start, end } of boundaries) output.overwrite(start, end, binding)
  }

  if (entries.length) {
    const binding = bind('livaEntry', 'livaPresenceEntry')

    for (const { directive, call, entry } of entries) {
      output.overwrite(directive.start, directive.end, binding)
      output.remove(call.start, entry.start)
      output.remove(entry.end, call.end)
    }
  }

  output.append(`\nimport { ${imports.join(', ')} } from 'liva:vue/presence';\n`)

  return { code: output.toString(), map: output.generateMap({ source: id, hires: true }) }
}

export const presenceReferencePlugin: Plugin = {
  name: 'liva:presence-reference',
  enforce: 'post',
  transform(code, id) {
    const [file, query = ''] = id.split('?', 2)
    const type = new URLSearchParams(query).get('type')

    // Vue may inline the render function into a script-setup submodule in production.
    if (
      file.endsWith('.vue') &&
      (!type || type === 'template' || type === 'script') &&
      code.includes(referencePrefix)
    ) {
      return linkPresenceReferences(code, id, (source) => this.parse(source))
    }

    return undefined
  },
}
