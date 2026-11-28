import { trackLayoutStyleSource } from './style-observation.ts'
import { isLayoutStyleProperty } from './style-properties.ts'

// Track Liva animation lifetimes independently of whether any Motion is measuring.
// When observation starts later it can see already-running effects in the document.
export const managedAnimations = new WeakMap<Document, Set<Animation>>()
export const visualProperties = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity'])
const observers = new WeakMap<Document, () => void>()

/** Connects the document's shared geometry scheduler to changes in the active set. */
export function observeGeometryAnimations(document: Document, invalidate: () => void) {
  observers.set(document, invalidate)

  return () => {
    observers.delete(document)
  }
}

/** Only Liva-managed layout effects opt into per-frame invalidation. */
export function trackLayoutAnimation(element: HTMLElement, property: string, animation: Animation) {
  if (isLayoutStyleProperty(property)) {
    trackLayoutStyleSource(element, animation)
    return
  }
  if (visualProperties.has(property)) return

  const document = element.ownerDocument
  let active = managedAnimations.get(document)

  if (!active) {
    active = new Set()
    managedAnimations.set(document, active)
  }

  if (active.has(animation)) return

  active.add(animation)
  observers.get(document)?.()

  const remove = () => {
    active.delete(animation)
    animation.removeEventListener('finish', remove)
    animation.removeEventListener('cancel', remove)
    observers.get(document)?.()
  }
  animation.addEventListener('finish', remove, { once: true })
  animation.addEventListener('cancel', remove, { once: true })
}
