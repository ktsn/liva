import type { DirectiveBinding } from 'vue'
import { releaseResources, type BrowserExecutor } from '@liva/runtime/core'
import type { PresenceEntry, PresenceTarget } from './presence.ts'

export interface PresenceBinding {
  readonly value: Record<string, unknown> | undefined
  readonly owner: readonly unknown[]
  readonly entries?: readonly PresenceEntry[]
}

interface Owner {
  readonly owner: object
  readonly key: readonly unknown[]
}

interface Target extends Owner {
  readonly names: Set<string>
  readonly entries: readonly PresenceEntry[]
  readonly registration: PresenceTarget
}

function isCompiledBinding(
  binding: DirectiveBinding,
): binding is DirectiveBinding<PresenceBinding> {
  return !!binding.modifiers.compiled
}

function sameKey(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Associates compiled routes with their physical root and retains departing target snapshots. */
export class PresenceBindings<Root extends { readonly executor: BrowserExecutor }> {
  private readonly owners = new Map<HTMLElement, Owner>()
  private readonly targets = new Map<HTMLElement, Target>()

  private readonly roots: ReadonlyMap<HTMLElement, Root>
  private readonly reconcile: () => void
  private readonly beforeRemoval: () => void

  constructor(
    roots: ReadonlyMap<HTMLElement, Root>,
    reconcile: () => void,
    beforeRemoval: () => void,
  ) {
    this.roots = roots
    this.reconcile = reconcile
    this.beforeRemoval = beforeRemoval
  }

  private root(target: Owner) {
    const element = [...this.owners].find(
      ([candidate, root]) =>
        this.roots.has(candidate) && root.owner === target.owner && sameKey(root.key, target.key),
    )?.[0]

    return element ? this.roots.get(element) : undefined
  }

  hasTarget(element: HTMLElement) {
    return this.targets.has(element)
  }

  rootFor(element: HTMLElement) {
    const target = this.targets.get(element)

    return target && this.root(target)
  }

  registerRoot(element: HTMLElement, owner: object, key: readonly unknown[]) {
    this.owners.set(element, { owner, key })
  }

  removeRoot(element: HTMLElement) {
    this.owners.delete(element)
  }

  registerTarget(element: HTMLElement, binding: DirectiveBinding, name = binding.arg) {
    if (!isCompiledBinding(binding) || !binding.value.entries) return

    // Compiled targets have static arguments, and root registrations pass self.
    const targetName = name!
    const existing = this.targets.get(element)

    if (existing) {
      existing.names.add(targetName)

      return
    }

    const target: Target = {
      owner: binding.instance!,
      names: new Set([targetName]),
      key: binding.value.owner,
      entries: binding.value.entries,
      registration: {
        capture: (phase, interrupted) => {
          this.reconcile()

          return this.root(target)?.executor.capturePresence(phase, [...target.names], {
            element,
            interrupted,
          })
        },
      },
    }

    this.targets.set(element, target)

    for (const entry of target.entries) {
      entry.beforeMutation = this.beforeRemoval
      entry.targets.add(target.registration)
    }
  }

  departingTargets(root: Root) {
    return [...this.targets]
      .filter(([, target]) => this.root(target) === root)
      .map(
        ([element]) =>
          () =>
            this.snapshotTarget(element),
      )
  }

  snapshotTarget(element: HTMLElement) {
    const target = this.targets.get(element)

    if (!target) return

    // A failed observation cannot leave the target registered with retained entries.
    releaseResources([
      () => {
        const work = target.registration.capture(
          'leave',
          target.entries.some((entry) => entry.session !== undefined),
        )

        for (const entry of target.entries) {
          if (work && !entry.snapshots.has(target.registration))
            entry.snapshots.set(target.registration, work)
        }
      },
      () => {
        for (const entry of target.entries) {
          entry.beforeMutation = this.beforeRemoval
          entry.targets.delete(target.registration)
          queueMicrotask(() => entry.snapshots.delete(target.registration))
        }
      },
    ])
  }

  removeTarget(element: HTMLElement) {
    this.targets.delete(element)
  }
}
