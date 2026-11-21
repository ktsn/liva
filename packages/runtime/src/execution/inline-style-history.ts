import { observeLayoutInline } from '../layout/layout-scheduler.ts'

import type { InlineValue } from './style-ownership.ts'

/** Splits browser-serialized declaration text, leaving CSS values opaque. */
function split(value: string, delimiter: string): string[] {
  const result: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  let comment = false
  let escaped = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]

    if (comment) {
      if (character === '*' && value[index + 1] === '/') {
        comment = false
        index++
      }

      continue
    }

    if (escaped) {
      escaped = false
      continue
    }

    if (character === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (character === quote) quote = ''
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '/' && value[index + 1] === '*') {
      comment = true
      index++
      continue
    }

    if ('([{'.includes(character)) depth++
    if (')]}'.includes(character)) depth--

    if (depth === 0 && character === delimiter) {
      result.push(value.slice(start, index))
      start = index + 1
    }
  }

  result.push(value.slice(start))
  return result
}

function declarations(style: CSSStyleDeclaration, document: Document) {
  return split(style.cssText, ';')
    .filter((value) => value.trim())
    .map((css) => {
      const parsed = document.createElement('div').style
      parsed.cssText = css
      const spelling = split(css, ':')[0].trim()
      // CSSOM serializes escaped custom identifiers; item() supplies their actual
      // property name, while ordinary shorthand names must remain shorthands.
      const name = spelling.startsWith('--') ? parsed.item(0) : spelling
      return {
        name,
        value: parsed.getPropertyValue(name),
        priority: parsed.getPropertyPriority(name),
        css,
        components: Array.from(parsed),
      }
    })
}

/** Native declarations that keep relative order need no movement in the source block. */
function stableNames(before: readonly string[], after: readonly string[]): ReadonlySet<string> {
  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  )

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lengths[i][j] =
        before[i] === after[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1])

  const stable = new Set<string>()
  let i = 0
  let j = 0

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      stable.add(before[i])
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++
    else j++
  }

  return stable
}

/**
 * Retains authored inline declaration order independently of generated slots.
 * Native mutation records are replayed in order into a detached CSS declaration
 * block; the browser retains shorthand/var/priority semantics. No CSS values are
 * interpreted, no layout is read, and no source DOM API is intercepted.
 */
export class InlineStyleHistory {
  private source: CSSStyleDeclaration
  private readonly subscription: ReturnType<typeof observeLayoutInline>
  private last: string
  private readonly pending: {
    before: string
    after: string
    written: ReadonlyMap<string, InlineValue>
  }[] = []

  private readonly element: HTMLElement
  private readonly written: ReadonlyMap<string, InlineValue>

  constructor(element: HTMLElement, written: ReadonlyMap<string, InlineValue>) {
    this.element = element
    this.written = written
    this.source = this.parse(element.style.cssText)
    this.last = element.getAttribute('style') ?? ''
    this.subscription = observeLayoutInline(element, ({ before, after, generated }) => {
      if (!generated && before !== after)
        this.pending.push({ before, after, written: new Map(this.written) })
      this.last = after
    })
  }

  private parse(css: string) {
    const style = this.element.ownerDocument.createElement('div').style
    style.cssText = css

    return style
  }

  private exposed(css: string, written: ReadonlyMap<string, InlineValue>) {
    const style = this.parse(css)

    for (const [name, value] of written) {
      if (
        style.getPropertyValue(name) === value.value &&
        style.getPropertyPriority(name) === value.priority
      )
        style.removeProperty(name)
    }

    return style
  }

  private change(beforeCss: string, afterCss: string, written: ReadonlyMap<string, InlineValue>) {
    // Commit only after every native CSSOM operation succeeds. A failed replay
    // retains the ordered event for recovery rather than a partial/stale baseline.
    const source = this.parse(this.source.cssText)
    const before = this.parse(beforeCss)
    const after = this.parse(afterCss)
    const beforeNames = Array.from(before)
    const afterNames = Array.from(after)
    const beforeSet = new Set(beforeNames)
    const afterSet = new Set(afterNames)

    // Deleting even an obscured declaration is an authored deletion, so inspect
    // raw keys before excluding generated values.
    for (const name of beforeNames) if (!afterSet.has(name)) source.removeProperty(name)

    const previous = new Map(
      declarations(this.exposed(beforeCss, written), this.element.ownerDocument).map((entry) => [
        entry.name,
        entry,
      ]),
    )
    const next = declarations(this.exposed(afterCss, written), this.element.ownerDocument)

    for (const entry of next) {
      const old = previous.get(entry.name)
      if (!old || old.value !== entry.value || old.priority !== entry.priority)
        source.setProperty(entry.name, entry.value, entry.priority)
    }

    // cssText/setAttribute can explicitly reorder existing declarations or insert
    // new ones before existing keys. Ordinary CSSOM setters retain existing slots;
    // newly authored formerly-generated slots above were appended to source order.
    const oldCommon = beforeNames.filter((name) => !name.startsWith('--') && afterSet.has(name))
    const newCommon = afterNames.filter((name) => !name.startsWith('--') && beforeSet.has(name))
    let seenCommon = false
    const inserted = afterNames
      .filter((name) => !name.startsWith('--'))
      .toReversed()
      .some((name) => {
        if (beforeSet.has(name)) {
          seenCommon = true
          return false
        }
        return seenCommon
      })

    if (inserted || oldCommon.some((name, index) => name !== newCommon[index])) {
      const parts = declarations(source, this.element.ownerDocument)
      const stable = stableNames(
        [...previous.keys()],
        next.map((entry) => entry.name),
      )

      const matches = (part: (typeof parts)[number], name: string) =>
        part.name === name || part.components.includes(name)

      const retained = parts.filter(
        (part) =>
          !next.some((entry) => matches(part, entry.name)) ||
          next.some((entry) => stable.has(entry.name) && matches(part, entry.name)),
      )
      const moving = new Set(parts.filter((part) => !retained.includes(part)))

      for (let index = 0; index < next.length; index++) {
        const part = parts.find(
          (candidate) => moving.has(candidate) && matches(candidate, next[index].name),
        )

        if (!part) continue

        moving.delete(part)
        const successors = next
          .slice(index + 1)
          .filter((entry) => stable.has(entry.name))
          .map((entry) => entry.name)
        const at = retained.findIndex((candidate) =>
          successors.some((name) => matches(candidate, name)),
        )

        if (at < 0) retained.push(part)
        else retained.splice(at, 0, part)
      }

      source.cssText = retained.map((entry) => entry.css).join(';')
    }

    this.source = source
  }

  current(): CSSStyleDeclaration {
    this.subscription.flush()
    const current = this.element.getAttribute('style') ?? ''
    // Detached retained elements no longer belong to the document observer.
    if (current !== this.last) {
      this.pending.push({ before: this.last, after: current, written: new Map(this.written) })
      this.last = current
    }

    while (this.pending.length > 0) {
      const entry = this.pending[0]
      this.change(entry.before, entry.after, entry.written)
      this.pending.shift()
    }

    return this.source
  }

  dispose() {
    this.current()
    this.subscription.dispose()
  }
}
