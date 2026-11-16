import { describe, expect, it, vi } from 'vite-plus/test'
import type { Definition } from '../model/definition.ts'
import type { ExecutionPort, RuntimeDiagnostic } from './execution-contracts.ts'
import type { PresentationPlan } from './presentation-planner.ts'
import { planReconciliation } from './presentation-planner.ts'
import { Runtime } from './runtime.ts'

const definition: Definition = {
  name: 'planning-phases',
  parameters: [{ name: 'enabled', type: 'boolean' }],
  layers: [
    {
      name: 'base',
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 },
      targets: [
        {
          name: 'box',
          properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
        },
      ],
    },
    {
      name: 'active',
      when: { kind: 'reference', path: ['enabled'] },
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 },
      targets: [
        { name: 'box', properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }] },
      ],
    },
  ],
}

/** A browser-free execution port whose terminal write and release change later observations. */
function setup() {
  let displayed = 0.2
  let velocity = 0
  let runtime: Runtime
  const plans: PresentationPlan[] = []
  const observations: { displayed: number; velocity: number }[] = []
  const errors: RuntimeDiagnostic[] = []
  const execution: ExecutionPort = {
    bindingFacts: { suspended: false },

    freezeEnvironment() {},

    validatePresence() {},

    present(_previous, next) {
      observations.push({ displayed, velocity })
      execution.applyPlan(planReconciliation(next, execution.presentationFacts(next).receivers))
    },

    initialize() {},
    configureControllers() {},
    connectSource: () => () => {},
    resetPresentation() {},
    refreshSuspension() {},
    endCompositionPreview() {},
    dispose() {},
    beginPreview() {},
    abortPreview() {},
    terminalControls() {
      displayed = 0.4
    },
    releaseControllers() {
      velocity = 0.002
    },
    applyControllers: () => new Map(),
    presentationFacts: () => ({
      mode: 'live',
      lifecycle: [],
      suspended: false,
      reduced: false,
      preserveLifecycle: false,
      receivers: [{ id: 3, target: 'box', protected: [] }],
      active: [],
    }),
    observeReceivers: () => [
      {
        id: 3,
        target: 'box',
        protected: [],
        fallbacks: [],
        addresses: [{ name: 'opacity', addresses: ['opacity'] }],
      },
    ],
    expandTracks: () => [],
    observeDisplayed: () => [],
    observeTracks: () => [],
    applyPlan: (plan) => {
      plans.push(plan)
      runtime.environment.acceptPresentation(plan.resolution)
    },
  }

  runtime = new Runtime(execution, definition, { enabled: false }, (error) => errors.push(error))

  return { runtime, execution, plans, observations, errors }
}

describe('Runtime presentation coordination', () => {
  it('requests presentation after terminal writes and controller release', () => {
    const { runtime, plans, observations, errors } = setup()

    runtime.updateParameters({ enabled: true })

    expect(plans).toHaveLength(1)
    expect(plans[0].writes).toEqual([{ receiver: 3, property: 'opacity', value: '1' }])
    expect(observations).toEqual([{ displayed: 0.4, velocity: 0.002 }])
    expect(runtime.composition.layers.active).toBe(true)
    expect(errors).toEqual([])

    runtime.dispose()
  })

  it('accepts composition only when execution has prepared the complete plan', () => {
    const { runtime, execution, errors } = setup()
    const before = runtime.composition
    const failure = new Error('Native effect preparation failed')
    const update = vi.fn<() => void>()
    runtime.onUpdate = update
    execution.applyPlan = (plan) => {
      expect(plan.resolution.composition.layers.active).toBe(true)
      expect(runtime.composition).toEqual(before)

      throw failure
    }

    runtime.updateParameters({ enabled: true })

    expect(runtime.composition).toEqual(before)
    expect(update).not.toHaveBeenCalled()
    expect(errors).toEqual([expect.objectContaining({ error: failure })])

    runtime.dispose()
  })
})

it('rejects invalid replacement layers before retiring the accepted environment', () => {
  const { runtime, errors } = setup()
  const previous = runtime.composition
  const invalid: Definition = {
    ...definition,
    layers: [
      ...definition.layers,
      {
        name: 'invalid',
        when: { kind: 'reference', path: ['missing'] },
        targets: [],
      },
    ],
  }

  expect(() => runtime.replaceDefinition(invalid)).toThrow('Unknown variable')
  expect(runtime.definition).toBe(definition)
  expect(runtime.composition).toEqual(previous)

  runtime.updateParameters({ enabled: true })

  expect(runtime.composition.layers.active).toBe(true)
  expect(errors).toEqual([])

  runtime.dispose()
})
