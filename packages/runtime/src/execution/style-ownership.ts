import { propertyRule } from '../motion/property-rules.ts'
import type { InlineStyleHistory } from './inline-style-history.ts'

export type InlineValue = { value: string; priority: string }

export function inlineDeclarations(style: CSSStyleDeclaration): Map<string, InlineValue> {
  return new Map(
    Array.from(style).map((property) => [
      property,
      {
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      },
    ]),
  )
}

export type OwnedElement = {
  element: HTMLElement
  original: Map<string, InlineValue>
  originalCss: string
  pending: Map<string, { property: string; value: string; priority: string }>
  written: Map<string, InlineValue>
  history?: InlineStyleHistory
}

/** Calculates the released baseline while preserving external CSS edits and serialization. */
export function restoredStyle(
  { original, originalCss, pending, written, history }: OwnedElement,
  cssText: string,
): CSSStyleDeclaration {
  if (history) return history.current()

  const baseline = document.createElement('div')
  const external = document.createElement('div')

  baseline.style.cssText = originalCss
  external.style.cssText = cssText

  const current = inlineDeclarations(external.style)
  // Removing a longhand can change the CSSOM serialization of a shorthand.
  // Compare every pending signature before pruning any declaration.
  const changedPending = new Set(
    [...pending]
      .filter(
        ([, signature]) =>
          external.style.getPropertyValue(signature.property) !== signature.value ||
          external.style.getPropertyPriority(signature.property) !== signature.priority,
      )
      .map(([property]) => property),
  )
  const stillOwned = new Set<string>()

  for (const [property, last] of written) {
    const value = current.get(property) ?? { value: '', priority: '' }

    if (
      !changedPending.has(property) &&
      value.value === last.value &&
      value.priority === last.priority
    ) {
      stillOwned.add(property)
      external.style.removeProperty(property)
    }
  }

  for (const property of original.keys()) {
    if (!stillOwned.has(property) && !current.has(property)) {
      baseline.style.removeProperty(property)
    }
  }

  for (const property of Array.from(external.style)) {
    baseline.style.removeProperty(property)
  }

  // Restore the intact original serialization, then overlay external writes.
  // This retains var()-valued shorthands that CSSOM cannot expose as longhands.
  baseline.style.cssText += ';' + external.style.cssText

  return baseline.style
}

/**
 * Owns one inline declaration and rebases its restoration baseline on external CSS edits.
 * Temporary owners can provide mutation tracking and an independent declaration history.
 */
export function writeOwnedStyle(
  ownership: OwnedElement[],
  element: HTMLElement,
  property: string,
  value: string,
  priority: string,
  options: {
    readonly history?: (owner: OwnedElement) => InlineStyleHistory
    readonly mutate?: (action: () => void) => void
    readonly reorder?: boolean
  } = {},
) {
  let owned = ownership.find((o) => o.element === element)
  owned?.history?.current()
  const before = inlineDeclarations(element.style)

  if (!owned) {
    owned = {
      element,
      original: before,
      originalCss: element.style.cssText,
      pending: new Map(),
      written: new Map(),
    }
    owned.history = options.history?.(owned)
    ownership.push(owned)
  }

  const beforeCss = element.style.cssText
  const mutate = options.mutate ?? ((action: () => void) => action())

  if (propertyRule(property)?.kind === 'length' || options.reorder) {
    // Keep logical/physical aliases in cascade order. Temporary logical size
    // constraints also follow current physical min/max declarations. Record
    // every actual mutation separately so intermediate own writes cannot look
    // like external layout changes to the shared MutationObserver.
    mutate(() => element.style.removeProperty(property))
  }

  mutate(() => element.style.setProperty(property, value, priority))

  const after = inlineDeclarations(element.style)

  const pending = document.createElement('div')
  if (beforeCss !== element.style.cssText) {
    pending.style.setProperty(property, value)
  }
  const pendingNames = new Set(
    Array.from(pending.style).filter((name) => pending.style.getPropertyValue(name) === ''),
  )

  let rebased = false

  // CSSOM enumerates the affected longhands, including shorthand side effects.
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(name)
    const next = after.get(name)

    if (
      pendingNames.has(name) ||
      previous?.value !== next?.value ||
      previous?.priority !== next?.priority
    ) {
      const last = owned.written.get(name)
      const previousValue = previous ?? { value: '', priority: '' }

      if (
        !rebased &&
        (!last || last.value !== previousValue.value || last.priority !== previousValue.priority)
      ) {
        const baseline = restoredStyle(owned, beforeCss)

        owned.originalCss = baseline.cssText
        owned.original = inlineDeclarations(baseline)
        rebased = true
      }

      owned.written.set(name, next ?? { value: '', priority: '' })

      if (pendingNames.has(name)) {
        owned.pending.set(name, {
          property,
          value: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
        })
      } else {
        owned.pending.delete(name)
      }
    }
  }
}
