import { LetBindingGraph } from '../../evaluation/let-bindings.ts'
import { ReactiveCallStore } from '../../evaluation/reactive-call-store.ts'
import type { ReactiveNotification } from '../../evaluation/events.ts'
import type { VariableValues } from '../../evaluation/expression.ts'
import type { LetBinding, Property, Target } from '../../model/definition.ts'

/** Test assembly for exercising graph evaluation within independently owned call stores. */
export class EvaluationFixture {
  readonly graph: LetBindingGraph
  readonly calls: ReactiveCallStore

  constructor(
    bindings: readonly LetBinding[],
    values: VariableValues,
    previous?: EvaluationFixture,
    targets: readonly Target<Property>[] = [],
  ) {
    this.graph = new LetBindingGraph(bindings, targets)
    this.calls = new ReactiveCallStore(
      previous?.calls,
      previous ? this.graph.compatibleBindings(previous.graph) : [],
    )

    try {
      this.evaluate(values)
    } catch (error) {
      this.calls.dispose(previous?.calls)

      throw error
    }
  }

  evaluate(
    variables: VariableValues,
    validate: (values: VariableValues) => void = () => {},
    notification?: ReactiveNotification,
  ): VariableValues {
    return this.calls.evaluate(
      (operations) =>
        this.graph.evaluate(variables, operations, (values) => {
          validate(values)

          return values
        }),
      notification,
    )
  }

  bind(
    targets: ReadonlyMap<string, HTMLElement>,
    update: (notification?: ReactiveNotification) => void,
  ) {
    return this.calls.bind((source, publish) => source.bind(targets, publish), update)
  }

  dispose(retained?: EvaluationFixture) {
    this.calls.dispose(retained?.calls)
  }
}
