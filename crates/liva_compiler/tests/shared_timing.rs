mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn shared_timing_preserves_all_scopes_and_bodyless_transition_expressions() {
    let source = "motion sample(active: boolean) {
      let quick = tween(duration: 150)
      @quick layer base {
        @tween(duration: 200) body { opacity: 1 @spring(duration: 300) }
        @quick state idle initial {}
        @spring(stiffness: 500) state on { body { opacity: 0.5 } }
        @spring(duration: 400)
        transition idle -> on
          when active { @quick body { @tween(duration: 500) opacity ~> { 50%: 0.8 @stepStart } } }
        @quick
        transition on -> idle
          when !active
      }
      @quick enter { body { opacity: 0 } }
      @spring(duration: 300) leave { body { opacity: 0 } }
    }";
    let compiled = valid(source);
    let definition = &compiled.definitions[0];
    let layer = &definition.layers[0];

    assert!(layer.timing_expression.is_some());
    assert!(layer.targets[0].timing_expression.is_some());
    assert!(layer.targets[0].properties[0].timing_expression.is_some());
    assert!(
        layer
            .states
            .iter()
            .all(|state| state.timing_expression.is_some())
    );
    assert!(
        layer
            .transitions
            .iter()
            .all(|transition| transition.transition.timing_expression.is_some())
    );
    assert!(layer.transitions[1].transition.targets.is_empty());
    assert!(
        definition
            .enter
            .as_ref()
            .unwrap()
            .timing_expression
            .is_some()
    );
    assert!(
        definition
            .leave
            .as_ref()
            .unwrap()
            .timing_expression
            .is_some()
    );
}

#[test]
fn style_tracks_accept_shared_timing_without_flattening_its_origin() {
    for source in [
        "motion sample { @tween() layer base { body { opacity ~> { 50%: 0.5; 100%: 1 } } } }",
        "motion sample { layer base { @tween() state idle initial { body { opacity ~> { 50%: 0.5; 100%: 1 } } } } }",
    ] {
        valid(source);
    }

    let result = valid("motion sample { layer base { @tween() body { opacity: 1 } } }");
    let target = &result.definitions[0].layers[0].targets[0];

    assert!(target.timing_expression.is_some());
    assert!(target.properties[0].timing_expression.is_none());
}

#[test]
fn unsupported_positions_and_mismatched_shared_types_are_rejected() {
    for source in [
        "motion @tween() sample { layer base {} }",
        "motion sample { let value @tween() = 1; layer base {} }",
        "motion sample { event @tween() done when true; layer base {} }",
        "motion sample { @easeOut layer base {} }",
        "motion sample { layer base { @true state idle initial {} } }",
        "motion sample { layer base { state idle initial {} @stepEnd transition idle -> idle when false } }",
        "motion sample { layer base { body { opacity: 1 } } @easeOut enter { body { opacity: 0 } } }",
        "motion sample { layer base @tween() @spring() {} }",
    ] {
        let result = compile(source, true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.severity == "error"),
            "{source}"
        );
    }
}
