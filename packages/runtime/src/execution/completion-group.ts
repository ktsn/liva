export type CompletionResult = 'completed' | 'superseded' | 'owner-teardown' | 'failed'

/**
 * Tracks the currently applicable effect identifiers, never native effects.
 * Replace membership before cancelling old effects; late settlements are ignored.
 * Start after all participants register. Completion/cancellation is idempotent.
 */
export class CompletionGroup {
  private readonly current = new Set<number>()
  private started = false
  private result?: CompletionResult
  private readonly resolve: (result: CompletionResult) => void
  readonly finished: Promise<CompletionResult>

  constructor() {
    let complete: ((result: CompletionResult) => void) | undefined
    this.finished = new Promise((resolve) => {
      complete = resolve
    })

    // Promise invokes its executor synchronously, assigning this local before returning.
    this.resolve = complete!
  }

  get isFinished() {
    return this.result !== undefined
  }

  replace(remove: readonly number[], add: readonly number[]) {
    if (this.isFinished) return

    for (const id of remove) this.current.delete(id)
    for (const id of add) this.current.add(id)

    this.check()
  }

  start() {
    if (this.isFinished) return

    this.started = true
    this.check()
  }

  settle(id: number, result: 'completed' | 'failed') {
    if (this.isFinished || !this.current.delete(id)) return false

    if (result === 'failed') this.end(result)
    else this.check()

    return true
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.end(reason)
  }
  fail() {
    this.end('failed')
  }

  private check() {
    if (this.started && this.current.size === 0) this.end('completed')
  }

  private end(result: CompletionResult) {
    if (this.isFinished) return

    this.result = result
    this.current.clear()
    this.resolve(result)
  }
}
