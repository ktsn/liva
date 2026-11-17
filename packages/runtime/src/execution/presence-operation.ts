import { CompletionGroup } from './completion-group.ts'

export type PresencePhase = 'enter' | 'leave'
export type PresenceResult = 'completed' | 'superseded' | 'owner-teardown' | 'failed'

const captureIdentity: unique symbol = Symbol('presence-capture')

/** Opaque captured participant. Its receiving elements, tracks and inputs belong to the executor. */
export interface PresenceCapture {
  readonly [captureIdentity]: true
}

/** Internal browser capabilities. No elements, tracks or native effects cross this boundary. */
export interface PresenceParticipant {
  release(captures: readonly PresenceCapture[]): void
  initialize(
    operation: PresenceOperation,
    phase: PresencePhase,
    captures: readonly PresenceCapture[],
  ): void
  play(operation: PresenceOperation): void
  end(operation: PresenceOperation, result: PresenceResult): void
}

const participants = new WeakMap<
  PresenceCapture,
  { readonly participant: PresenceParticipant; readonly phase: PresencePhase }
>()

/** Registers only the opaque identity and browser capabilities; capture data stays with its owner. */
export function createPresenceCapture(
  participant: PresenceParticipant,
  phase: PresencePhase,
): PresenceCapture {
  const capture: PresenceCapture = Object.freeze({ [captureIdentity]: true as const })

  participants.set(capture, { participant, phase })

  return capture
}

/**
 * Boundary completion barrier across captured participants. Executors own their
 * effects and replace the group's numeric membership when retargeting. initialize
 * releases captured effects, supersedes the previous operation, then initializes
 * every participant before first paint. play seals startup, including empty work.
 * Unexpected failures are reported and settle as failed; initialize also rethrows.
 */
export class PresenceOperation {
  private readonly participants = new Map<PresenceParticipant, PresenceCapture[]>()
  private ended = false
  private initialized = false
  private started = false
  private resolve!: (result: PresenceResult) => void
  readonly finished = new Promise<PresenceResult>((resolve) => {
    this.resolve = resolve
  })
  readonly completion = new CompletionGroup<PresenceResult>('completed', (result) =>
    this.end(result),
  )

  private readonly phase: PresencePhase
  private readonly report: (error: unknown) => void

  constructor(
    captures: readonly PresenceCapture[],
    phase: PresencePhase,
    report: (error: unknown) => void = console.error,
  ) {
    this.phase = phase
    this.report = report

    const seen = new Set<PresenceCapture>()

    for (const capture of captures) {
      if (seen.has(capture)) continue

      seen.add(capture)
      const registration = participants.get(capture)

      if (!registration) throw new Error('Unknown presence capture')
      if (registration.phase !== phase)
        throw new Error('Presence capture phase does not match operation')

      const { participant } = registration
      const owned = this.participants.get(participant) ?? []

      owned.push(capture)
      this.participants.set(participant, owned)
    }
  }

  get isFinished(): boolean {
    return this.ended
  }

  initialize(previous?: PresenceOperation) {
    if (this.ended || this.initialized) return

    this.initialized = true

    try {
      for (const [participant, captures] of this.participants) participant.release(captures)

      previous?.cancel('superseded')

      for (const [participant, captures] of this.participants) {
        participant.initialize(this, this.phase, captures)
      }
    } catch (error) {
      this.fail(error)

      throw error
    }
  }

  play() {
    if (this.ended || this.started) return

    this.started = true

    try {
      this.initialize()

      if (this.ended) return

      for (const participant of this.participants.keys()) {
        participant.play(this)
      }

      this.completion.seal()
    } catch (error) {
      this.fail(error)
    }
  }

  /** Reports a browser failure while resolving the operation's failed result. */
  fail(error: unknown) {
    if (this.ended) return

    this.completion.end('failed')
    this.report(error)
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.completion.end(reason)
  }

  private end(result: PresenceResult) {
    this.ended = true

    for (const participant of this.participants.keys()) {
      try {
        participant.end(this, result)
      } catch (error) {
        this.report(error)
      }
    }

    this.participants.clear()
    this.resolve(result)
  }
}
