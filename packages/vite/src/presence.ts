import { NodeTypes, ElementTypes, type ElementNode, type DirectiveNode } from '@vue/compiler-core'
import { MagicString, parse } from '@vue/compiler-sfc'
import { hasLifecycle, lifecycleTransitions, ROOT_TARGET, type Definition } from '@liva/runtime'

type Root = NonNullable<ReturnType<typeof parse>['descriptor']['template']>['ast']
type Element = ElementNode
type Directive = DirectiveNode

export interface PresenceBoundary {
  id: number
  operation: 'if' | 'for' | 'show' | 'mount'
  range: { start: number; end: number }
  strategy: 'Transition' | 'TransitionGroup' | 'persisted Transition'
  targets: { motion: string; target: string; enter: boolean; leave: boolean }[]
}

export class PresenceError extends Error {
  readonly loc: { line: number; column: number }

  constructor(message: string, loc: { line: number; column: number }) {
    super(message)
    this.loc = loc
  }
}

const directive = (node: Element, name: string) =>
  node.props.find(
    (prop): prop is Directive => prop.type === NodeTypes.DIRECTIVE && prop.name === name,
  )
const argument = (prop: Directive | undefined) =>
  prop?.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic
    ? prop.arg.content
    : undefined
const keyOf = (node: Element) => {
  const key = node.props.find(
    (prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && argument(prop) === 'key',
  )
  if (key?.type === NodeTypes.DIRECTIVE && key.exp?.type === NodeTypes.SIMPLE_EXPRESSION)
    return key.exp.content
  const fixed = node.props.find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'key')
  return fixed?.type === NodeTypes.ATTRIBUTE && fixed.value
    ? JSON.stringify(fixed.value.content)
    : undefined
}
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

export function planPresence(
  source: string,
  filename: string,
  definitions: readonly Definition[],
): { code: string; map: ReturnType<MagicString['generateMap']>; boundaries: PresenceBoundary[] } {
  const { descriptor } = parse(source, { filename })
  const ast = descriptor.template?.ast
  const output = new MagicString(source)
  const paths = new Map<Element, Element[]>()
  const chains = new Map<Element, Element[]>()
  const roots = new Map<Element, { id: number; definition: Definition }>()
  const boundaries = new Map<Element, PresenceBoundary>()
  const associations = new Map<Element, { root: Element; boundaries: Element[]; self: boolean }>()
  const fail = (node: Element, message: string): never => {
    throw new PresenceError(message, {
      line: node.loc.start.line,
      column: node.loc.start.column - 1,
    })
  }

  const visit = (children: NonNullable<Root>['children'], ancestors: Element[]) => {
    let chain: Element[] | undefined

    for (const child of children) {
      if (child.type !== NodeTypes.ELEMENT) {
        if (
          child.type !== NodeTypes.COMMENT &&
          !(child.type === NodeTypes.TEXT && !child.content.trim())
        )
          chain = undefined
        continue
      }
      const path = [...ancestors, child]
      paths.set(child, path)

      if (directive(child, 'if')) chain = [child]
      else if (directive(child, 'else-if') || directive(child, 'else')) chain?.push(child)
      else chain = undefined
      if (chain) chains.set(child, chain)

      const motionDirective = directive(child, 'liva')
      const name = argument(motionDirective)
      if (motionDirective && !name && definitions.some(hasLifecycle)) {
        fail(child, 'Liva presence requires a static Motion directive argument.')
      }
      const definition = definitions.find((item) => item.name === name)
      if (definition) roots.set(child, { id: roots.size, definition })
      visit(child.children, path)
    }
  }
  visit(ast?.children ?? [], [])

  const operation = (node: Element): PresenceBoundary['operation'] | undefined =>
    directive(node, 'for')
      ? 'for'
      : chains.has(node)
        ? 'if'
        : directive(node, 'show')
          ? 'show'
          : undefined

  for (const [target, path] of paths) {
    const targetDirective = directive(target, 'liva-target')
    const selfTarget =
      roots.has(target) &&
      lifecycleTransitions(roots.get(target)!.definition, 'enter')
        .concat(lifecycleTransitions(roots.get(target)!.definition, 'leave'))
        .some((transition) => transition.targets.some((item) => item.name === ROOT_TARGET))
    if (!targetDirective && !selfTarget) continue
    const root = path.findLast((node) => directive(node, 'liva'))
    if (!root || !roots.has(root)) continue
    const { definition } = roots.get(root)!
    const declaredName = argument(targetDirective)
    if (targetDirective && !declaredName && hasLifecycle(definition)) {
      fail(target, 'Liva presence requires a static target directive argument.')
    }
    const targetNames = [
      ...(selfTarget ? [ROOT_TARGET] : []),
      ...(declaredName ? [declaredName] : []),
    ]
    if (!targetNames.length) continue
    const enter = lifecycleTransitions(definition, 'enter').some((transition) =>
      transition.targets.some((item) => targetNames.includes(item.name)),
    )
    const leave = lifecycleTransitions(definition, 'leave').some((transition) =>
      transition.targets.some((item) => targetNames.includes(item.name)),
    )
    if (!enter && !leave) continue

    if (target.tagType !== ElementTypes.ELEMENT || root.tagType !== ElementTypes.ELEMENT) {
      fail(
        target,
        'Liva lifecycle targets and Motion roots must be native elements in the same SFC.',
      )
    }

    const operations = path.filter((node) => operation(node))
    if (!operations.length && enter) operations.push(target)
    const associated: Element[] = []

    for (const node of operations) {
      if (node.tagType !== ElementTypes.ELEMENT) {
        fail(
          node,
          'Liva presence requires a native structural element. Move v-if/v-for/v-show onto a native element.',
        )
      }
      if (
        path
          .slice(path.indexOf(node), path.indexOf(target))
          .some((ancestor) => ancestor.tagType === ElementTypes.COMPONENT)
      ) {
        fail(
          node,
          'Liva cannot delay removal across a child component. Keep the structural operation and targets in native elements in this SFC.',
        )
      }
      const op = operation(node) ?? 'mount'
      if (
        [directive(node, 'for'), directive(node, 'if'), directive(node, 'show')].filter(Boolean)
          .length > 1
      ) {
        fail(
          node,
          'Separate combined v-if/v-for/v-show operations onto nested native elements for Liva presence.',
        )
      }
      if (op === 'for' && !keyOf(node))
        fail(node, 'Liva leave/enter animations in v-for require an explicit :key.')

      const ancestors = paths.get(node)!.slice(0, -1).toReversed()
      for (const ancestor of ancestors) {
        if (
          ['Transition', 'transition', 'TransitionGroup', 'transition-group'].includes(ancestor.tag)
        ) {
          fail(
            ancestor,
            'Vue Transition conflicts with Liva lifecycle ownership. Remove the Vue Transition and define enter/leave animations in Liva.',
          )
        }
        if (ancestor.tagType === ElementTypes.ELEMENT) break
      }

      const owner = chains.get(node)?.[0] ?? node
      let boundary = boundaries.get(owner)
      if (!boundary) {
        const members = chains.get(owner) ?? [owner]
        boundary = {
          id: boundaries.size,
          operation: op,
          range: { start: owner.loc.start.offset, end: members.at(-1)!.loc.end.offset },
          strategy:
            op === 'for'
              ? 'TransitionGroup'
              : op === 'show'
                ? 'persisted Transition'
                : 'Transition',
          targets: [],
        }
        boundaries.set(owner, boundary)
      }
      for (const targetName of new Set(targetNames)) {
        if (
          !boundary.targets.some(
            (item) => item.motion === definition.name && item.target === targetName,
          )
        ) {
          const targetEnter = lifecycleTransitions(definition, 'enter').some((transition) =>
            transition.targets.some((item) => item.name === targetName),
          )
          const targetLeave = lifecycleTransitions(definition, 'leave').some((transition) =>
            transition.targets.some((item) => item.name === targetName),
          )

          if (targetEnter || targetLeave)
            boundary.targets.push({
              motion: definition.name,
              target: targetName,
              enter: targetEnter,
              leave: targetLeave,
            })
        }
      }
      associated.push(owner)
    }
    associations.set(target, { root, boundaries: associated, self: selfTarget })
  }

  const ownerExpression = (root: Element) => {
    const keys = paths
      .get(root)!
      .filter((node) => directive(node, 'for'))
      .map((node) => {
        const key = keyOf(node)
        /* v8 ignore if -- @preserve: Every repeated ancestor was already checked while planning its structural boundary. */
        if (!key) fail(node, 'Repeated Liva lifecycle Motion roots require an explicit :key.')
        return key
      })
    return `[${roots.get(root)!.id}${keys.length ? ', ' + keys.join(', ') : ''}]`
  }
  const entryExpression = (owner: Element, target: Element) => {
    const boundary = boundaries.get(owner)!
    /* v8 ignore next -- @preserve: Associated owners are selected from this target's ancestor path. */
    const member =
      paths.get(target)!.find((node) => (chains.get(node)?.[0] ?? node) === owner) ?? owner
    const key =
      boundary.operation === 'for'
        ? keyOf(owner)!
        : (keyOf(member) ?? String(chains.get(owner)?.indexOf(member) ?? 0))
    return `livaBoundary${boundary.id}.item(${key})`
  }
  const add = (node: Element, text: string) =>
    output.appendLeft(node.loc.start.offset + 1 + node.tag.length, text)

  const withPresence = (node: Element, name: string, metadata: string) => {
    const prop = directive(node, name)!
    const value =
      prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION
        ? prop.exp.content.trim() || 'undefined'
        : 'undefined'
    const modifiers = prop.modifiers.map((modifier) => `.${modifier.content}`).join('')

    output.overwrite(
      prop.loc.start.offset,
      prop.loc.end.offset,
      `v-${name}:${argument(prop)}${modifiers}.compiled="${attr(`{ value: (${value}), ${metadata} }`)}"`,
    )
  }

  for (const [root] of roots) {
    if ([...associations.values()].some((association) => association.root === root)) {
      const association = associations.get(root)
      const entries = association?.self
        ? association.boundaries.map((owner) => entryExpression(owner, root))
        : undefined
      withPresence(
        root,
        'liva',
        `owner: ${ownerExpression(root)}${entries ? `, entries: [${entries.join(', ')}]` : ''}`,
      )
    }
  }
  for (const [target, association] of associations) {
    const entries = association.boundaries.map((owner) => entryExpression(owner, target))
    if (!directive(target, 'liva-target')) continue

    withPresence(
      target,
      'liva-target',
      `owner: ${ownerExpression(association.root)}, entries: [${entries.join(', ')}]`,
    )
  }
  for (const [owner, boundary] of boundaries) {
    const members = chains.get(owner) ?? [owner]
    for (const member of members) {
      add(member, ` v-liva-entry="${attr(entryExpression(owner, member))}"`)
    }
    output.prependLeft(
      boundary.range.start,
      `<LivaPresenceBoundary :group="${boundary.operation === 'for'}" :persisted="${boundary.operation === 'show'}" v-slot="livaBoundary${boundary.id}">`,
    )
    output.appendRight(boundary.range.end, '</LivaPresenceBoundary>')
  }

  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: filename, includeContent: true }),
    boundaries: [...boundaries.values()],
  }
}
