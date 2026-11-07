mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn shared_timing_preserves_all_scopes_and_bodyless_transition_expressions() {
    let source = "motion sample(active: boolean) {
      let quick = tween(duration: 150)
      layer base @quick {
        body @tween(duration: 200) { opacity: 1 @spring(duration: 300) }
        state idle initial @quick {}
        state on @spring(stiffness: 500) { body { opacity: 0.5 } }
        transition idle -> on
          @spring(duration: 400)
          when active { body @quick { opacity @tween(duration: 500) { 50%: 0.8 @stepStart } } }
        transition on -> idle
          @quick
          when !active
      }
      enter @quick { body { opacity: 0 } }
      leave @spring(duration: 300) { body { opacity: 0 } }
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
        "motion sample { layer base @tween() { body { opacity { 50%: 0.5; 100%: 1 } } } }",
        "motion sample { layer base { state idle initial @tween() { body { opacity { 50%: 0.5; 100%: 1 } } } } }",
    ] {
        valid(source);
    }

    let result = valid("motion sample { layer base { body @tween() { opacity: 1 } } }");
    let target = &result.definitions[0].layers[0].targets[0];

    assert!(target.timing_expression.is_some());
    assert!(target.properties[0].timing_expression.is_none());
}

#[test]
fn unsupported_positions_and_mismatched_shared_types_are_rejected() {
    for source in [
        "motion sample @tween() { layer base {} }",
        "motion sample { let value @tween() = 1; layer base {} }",
        "motion sample { event done @tween() when true; layer base {} }",
        "motion sample { layer base @easeOut {} }",
        "motion sample { layer base { state idle initial @true {} } }",
        "motion sample { layer base { state idle initial {} transition idle -> idle @stepEnd when false } }",
        "motion sample { layer base { body { opacity: 1 } } enter @easeOut { body { opacity: 0 } } }",
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
