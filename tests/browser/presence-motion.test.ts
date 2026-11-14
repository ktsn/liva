import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/')
})

for (const name of [
  'retarget',
  'timing',
  'liveLeave',
  'settledGap',
  'freshStart',
  'lowerUpdates',
  'relativeRetarget',
  'multiOwner',
] as const) {
  test(`shared presence ${name}`, async ({ page }) => {
    const result = await page.evaluate(async (caseName) => {
      const { presenceCases } = await import('./presence-cases.ts')

      return presenceCases[caseName]()
    }, name)

    if (name === 'multiOwner')
      expect(result).toEqual({
        premature: false,
        endpoints: ['0.6', '0.6'],
        result: 'completed',
        remaining: 0,
        errors: 0,
      })
    else if (name === 'timing') expect(result).toEqual([160, 240, 400])
    else if (name === 'retarget')
      expect(result).toMatchObject({
        start: '0.25',
        sampled: '0.25',
        duration: 80,
        end: '0.6',
        premature: false,
        result: 'completed',
        diagnostics: 0,
        failures: 0,
      })
    else if (name === 'liveLeave')
      expect(result).toEqual({
        start: '0.8',
        initial: '0.8',
        end: '0.6',
        premature: false,
        result: 'completed',
        errors: 0,
      })
    else if (name === 'settledGap')
      expect(result).toEqual({ retained: true, result: '0.6', errors: 0 })
    else if (name === 'freshStart')
      expect(result).toEqual({ initialized: '0.3', first: '0.3', errors: 0 })
    else if (name === 'lowerUpdates')
      expect(result).toEqual({
        retained: true,
        before: '0.75',
        after: '0.75',
        scale: '1.5',
        errors: 0,
      })
    else if (name === 'relativeRetarget')
      expect(result).toEqual({
        changed: true,
        end: '40px',
        premature: false,
        historyStable: true,
        guardActive: true,
        errors: 0,
      })
  })
}

for (const detached of [false, true]) {
  test(`retains final disposal environment detached=${detached}`, async ({ page }) => {
    const result = await page.evaluate(async (isDetached) => {
      const { presenceCases } = await import('./presence-cases.ts')

      return presenceCases.detachedEnvironment(isDetached)
    }, detached)

    expect(result).toEqual({
      end: '0.6',
      result: 'completed',
      sourceReleased: true,
      remaining: 0,
      errors: 0,
    })
  })
}

for (const [expired, newer] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(`preserves direct handoff freshness expired=${expired} newer=${newer}`, async ({ page }) => {
    const result = await page.evaluate(
      async ([isExpired, isNewer]) => {
        const { presenceCases } = await import('./presence-cases.ts')

        return presenceCases.directHandoff(isExpired, isNewer)
      },
      [expired, newer],
    )

    expect(result.start).toBe(newer ? -30 : 10)
    expect(result.errors).toBe(0)

    if (expired || newer) expect(result.next).toBeLessThan(result.start)
    else expect(result.next).toBeGreaterThan(result.start)
  })
}

for (const presence of [false, true]) {
  test(`separates authored spring endpoint from completion presence=${presence}`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (isPresence) => {
      const { presenceCases } = await import('./presence-cases.ts')

      return presenceCases.authoredEndpoint(isPresence)
    }, presence)

    expect(Math.abs(result.start - result.incoming)).toBeLessThan(0.1)
    expect(result.last).toBe('50px')
    expect(result.final).toBe(presence ? '100px' : '200px')
    expect(result.diagnostics).toEqual(presence ? [] : ['runtime.endpoint'])
    expect(result.failures).toBe(0)
  })
}

test('observes reduced motion after starting a captured leave on a disposed owner', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const finished = page.evaluate(async () => {
    const { presenceCases } = await import('./presence-cases.ts')

    return presenceCases.lateReduced()
  })
  await page.locator('[data-presence-ready]').waitFor()

  await page.emulateMedia({ reducedMotion: 'reduce' })

  expect(await finished).toEqual({ result: 'completed', remaining: 0, restored: '', errors: 0 })
})

test('hands ordinary spring momentum through leave and reentry', async ({ page }) => {
  const motion = await page.evaluate(async () => {
    const { presenceCases } = await import('./presence-cases.ts')

    return presenceCases.momentum()
  })

  // CSS serialization follows the existing 0.1px spring continuity contract.
  expect(Math.abs(motion.leaveStart - motion.ordinary)).toBeLessThan(0.1)
  expect(motion.leaveNext).toBeGreaterThan(motion.leaveStart)
  expect(Math.abs(motion.enterStart - motion.returning)).toBeLessThan(0.1)
  expect(motion.enterNext).toBeLessThan(motion.enterStart)
  expect(motion.errors).toBe(0)
  expect(motion.result).toBe('completed')
})

for (const expired of [false, true]) {
  test(`preserves captured DOM-sample expiry after disposal expired=${expired}`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (isExpired) => {
      const { presenceCases } = await import('./presence-cases.ts')

      return presenceCases.directExpiry(isExpired)
    }, expired)

    expect(result.start).toBe(10)
    expect(Math.sign(result.next - result.start)).toBe(expired ? -1 : 1)
    expect(result.errors).toBe(0)
  })
}

for (const completion of [false, true]) {
  test(`observes retained relative reference for completion=${completion}`, async ({ page }) => {
    const result = await page.evaluate(async (isCompletion) => {
      const { presenceCases } = await import('./presence-cases.ts')

      return presenceCases.relativeRole(isCompletion)
    }, completion)

    expect(result).toEqual({
      changed: true,
      end: completion ? '50px' : '40px',
      result: 'completed',
      final: '0px',
      errors: 0,
    })
  })
}

test('uses target-wide controller ownership across two logical receivers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { presenceCases } = await import('./presence-cases.ts')

    return presenceCases.controllerOwnership()
  })

  expect(result).toEqual({
    retained: true,
    unchanged: true,
    otherStable: true,
    increment: 10,
    errors: 0,
  })
})

test('samples an available native trajectory at final planning time and playback rate', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { presenceCases } = await import('./presence-cases.ts')

    return presenceCases.laterTrajectory()
  })

  expect(Math.abs(result.start - result.latest)).toBeLessThan(0.1)
  expect(result.next).toBeLessThan(result.start)
  expect(result.result).toBe('completed')
  expect(result.errors).toBe(0)
})

for (const [explicit, disposed, existing] of [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
]) {
  test(`cleans failed phase preparation explicit=${explicit} disposed=${disposed} existing=${existing}`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ([initialize, ownerDisposed, hasExisting]) => {
        const { presenceCases } = await import('./presence-cases.ts')

        return presenceCases.failedPreparation(initialize, ownerDisposed, hasExisting)
      },
      [explicit, disposed, existing],
    )

    expect(result).toEqual({
      result: 'failed',
      stillFailed: 'failed',
      reports: 1,
      causePreserved: true,
      explicitThrew: explicit,
      message: 'Tween duration must be non-negative milliseconds',
      remainingListeners: 0,
      remainingEffects: 0,
      diagnostics: 0,
      continued: true,
      continuingResult: 'completed',
    })
  })
}
