import { ordinaryLayer } from '../composition/runtime-layers.ts'
import type { LayerResolution } from '../composition/layers.ts'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { Definition } from '../model/definition.ts'
import type { ExecutionPort, RuntimeDiagnostic } from './execution-contracts.ts'
import type { PresentationPlan } from './presentation-planner.ts'
import { layerPropertyKey } from './presentation-planner.ts'
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
  let accepted: LayerResolution
  const plans: PresentationPlan[] = []
  const errors: RuntimeDiagnostic[] = []
  const execution: ExecutionPort = {
    bindingFacts: { suspended: false },
    initialize(resolution) {
      accepted = resolution
    },
    validatePresentation() {},
    retainEnvironment() {},
    releasePresence() {
      throw new Error('No presence in this fixture')
    },
    observeReleasedReceiver() {
      throw new Error('No presence in this fixture')
    },
    finishPresenceRelease() {},
    observeTakeoverAddresses: () => [],
    updatePresence() {},
    preparePresence(next) {
      return {
        reduced: false,
        preserve: false,
        active: [],
        operations: [],
        receivers: [
          {
            id: 3,
            names: ['box'],
            normal: next,
            previous: accepted,
            from: [ordinaryLayer(accepted)],
            to: [ordinaryLayer(next)],
          },
        ],
      }
    },
    observeReceiverStarts(_receiver, templates) {
      return new Map(
        templates
          .filter((track) => track.implicitStart)
          .map((track) => [layerPropertyKey(track.target, track.property), String(displayed)]),
      )
    },
    observeReceiverAddresses() {
      return [{ target: 'box', addresses: [{ name: 'opacity', addresses: ['opacity'] }] }]
    },
    abortPresencePlanning() {},
    configureControllers() {},
    disconnectBindings() {},
    connectBindings() {},
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
        addresses: [{ name: 'opacity', addresses: ['opacity'] }],
      },
    ],
    expandTracks: (sources) =>
      sources.map((source) => ({
        ...source,
        track: source.source,
        declarations: [{ name: 'opacity', addresses: ['opacity'] }],
        protected: false,
      })),
    observeDisplayed: () => [],
    observeTracks: (requests) =>
      requests.map((request, id) => ({
        id,
        receiver: request.receiver,
        source: request.source,
        track: request.track,
        declarations: request.declarations,
        interrupted: request.interrupted,
        displayed: request.needs.displayed ? String(displayed) : undefined,
        motion: request.needs.motion
          ? {
              start: { value: [displayed], velocity: [velocity] },
              end: [Number(request.track.destinationValue)],
              relative: false,
            }
          : undefined,
      })),
    applyPlan: (plan) => {
      accepted = plan.resolution
      plans.push(plan)
      runtime.environment.acceptPresentation(plan.resolution)
    },
  }
  runtime = new Runtime(execution, definition, { enabled: false }, (error) => errors.push(error))

  return { runtime, execution, plans, errors }
}

describe('Runtime presentation coordination', () => {
  it('plans from post-terminal position and post-release velocity without a browser', () => {
    const { runtime, plans, errors } = setup()

    runtime.updateParameters({ enabled: true })

    expect(plans).toHaveLength(1)
    expect(plans[0].writes).toEqual([{ receiver: 3, property: 'opacity', value: '1' }])
    expect(plans[0].start).toHaveLength(1)
    expect(plans[0].start[0].trajectory?.(0).value[0]).toBeCloseTo(0.4, 12)
    expect(plans[0].start[0].trajectory?.(0).velocity[0]).toBeCloseTo(0.002, 12)
    expect(runtime.composition.layers.active).toBe(true)
    expect(errors).toEqual([])

    runtime.dispose()
  })

  it('ignores a delayed lifecycle notification after its registration has been released', () => {
    const { runtime, plans } = setup()

    runtime.environment.lifecycleSettled()

    expect(plans).toEqual([])
    expect(runtime.composition.layers.active).toBe(false)

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
