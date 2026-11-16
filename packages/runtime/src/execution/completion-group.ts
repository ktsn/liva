/**
 * Tracks the current effects of one operation, independently of their browser owner.
 * Replacements publish their complete membership together. Completion is deferred to
 * the end of the turn so cancellation callbacks and participant startup cannot finish
 * a boundary between removal of old effects and registration of their replacements.
 */
export class CompletionGroup<Result extends string> {
  private readonly effects = new Set<number>()
  private sealed = false
  private ended = false
  private scheduled = false

  private readonly completed: Result
  private readonly settle: (result: Result) => void

  constructor(completed: Result, settle: (result: Result) => void) {
    this.completed = completed
    this.settle = settle
  }

  replace(previous: readonly number[], next: readonly number[]) {
    if (this.ended) return

    for (const id of previous) this.effects.delete(id)

    for (const id of next) this.effects.add(id)

    this.check()
  }

  seal() {
    this.sealed = true
    this.check()
  }

  end(result: Result) {
    if (this.ended) return

    this.ended = true
    this.effects.clear()
    this.settle(result)
  }

  private check() {
    if (this.scheduled || !this.sealed || this.ended) return

    this.scheduled = true

    queueMicrotask(() => {
      this.scheduled = false

      if (!this.ended && this.effects.size === 0) this.end(this.completed)
    })
  }
}
