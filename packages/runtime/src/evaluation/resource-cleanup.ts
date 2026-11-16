/**
 * Runs independent cleanup callbacks in the supplied order, attempting every owner.
 * Callers invalidate registrations first. A single failure propagates unchanged;
 * multiple failures become AggregateError with the first failure as cause.
 */
export function releaseResources(cleanups: readonly (() => void)[]) {
  const failures: unknown[] = []

  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Could not release resources', { cause: failures[0] })
}
