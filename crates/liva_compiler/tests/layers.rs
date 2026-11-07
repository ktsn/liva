mod support;

use liva_compiler::compile;
use support::valid;

fn layered_motion() -> liva_compiler::Compilation {
    valid(
        r#"motion button(hovered: boolean, pressed: boolean, size: number) {
        layer base { body { scale: 1; translate: 0 2px } }
        layer hover when hovered { body { scale: ${size} } }
        layer press when pressed { body { scale: .9 } }
    }"#,
    )
}

#[test]
fn layers_preserve_source_order_without_lowering_to_exclusive_states() {
    let result = layered_motion();
    let definition = &result.definitions[0];

    assert_eq!(
        definition
            .layers
            .iter()
            .map(|layer| layer.name.as_str())
            .collect::<Vec<_>>(),
        ["base", "hover", "press"]
    );
}

#[test]
fn unconditional_and_conditional_layers_retain_independent_guards() {
    let result = layered_motion();
    let layers = &result.definitions[0].layers;

    assert!(layers[0].when.is_none());
    assert!(layers[1].when.is_some());
    assert!(layers[2].when.is_some());
}

#[test]
fn layer_values_preserve_css_and_lower_interpolation() {
    let result = layered_motion();
    let layers = &result.definitions[0].layers;

    assert_eq!(layers[0].targets[0].properties[1].value, "0 2px");
    assert!(layers[1].targets[0].properties[0].template.is_some());
}

#[test]
fn layer_conditions_require_valid_boolean_expressions() {
    for condition in ["1", "'yes'", "missing", "true &&", ""] {
        let source =
            format!("motion button {{ layer hover when {condition} {{ body {{ scale: 1 }} }} }}");
        let result = compile(&source, true);

        assert!(!result.diagnostics.is_empty(), "{source}");
    }
}

#[test]
fn duplicate_layer_names_are_rejected_in_the_layer_namespace() {
    let result = compile("motion button { layer base {} layer base {} }", true);

    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate")
    );
}

#[test]
fn incomplete_layer_headers_report_diagnostics_without_panicking() {
    let result = compile("motion button { layer {} }", true);

    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "syntax.name")
    );
}

#[test]
fn layers_do_not_enable_removed_motion_states() {
    for states in ["state hover when true {}", "state first {} state second {}"] {
        let source = format!("motion button {{ layer base {{}} {states} }}");
        let result = compile(&source, true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.state-scope")
        );
    }
}

#[test]
fn stateful_layers_keep_common_styles_and_state_overrides_separate() {
    let result = valid(
        "motion submit { layer submission { button { opacity: 1 } state idle initial { spinner { opacity: 0 } } state loading { button { opacity: .5 } spinner { opacity: 1 } } } }",
    );
    let layer = &result.definitions[0].layers[0];

    assert_eq!(layer.initial_state.as_deref(), Some("idle"));
    assert_eq!(layer.targets[0].properties[0].value, "1");
    assert_eq!(layer.states[1].value("button", "opacity"), Some(".5"));
    assert_eq!(layer.states[0].value("spinner", "opacity"), Some("0"));
}

#[test]
fn state_names_and_initial_states_are_local_to_each_layer() {
    let result = valid(
        "motion submit { layer first { state idle initial {} state active {} } layer second { state idle {} state active initial {} } }",
    );
    let layers = &result.definitions[0].layers;

    assert_eq!(layers[0].initial_state.as_deref(), Some("idle"));
    assert_eq!(layers[1].initial_state.as_deref(), Some("active"));
}

#[test]
fn stateful_layers_require_one_initial_state() {
    for states in [
        "state idle {}",
        "state idle initial {} state loading initial {}",
    ] {
        let result = compile(
            &format!("motion submit {{ layer submission {{ {states} }} }}"),
            true,
        );

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.initial-state")
        );
    }
}

#[test]
fn stateful_layers_reject_guards_and_duplicate_state_names() {
    for (layer, code) in [
        (
            "layer submission when true { state idle initial {} }",
            "semantic.layer-condition",
        ),
        (
            "layer submission { state idle initial {} state idle {} }",
            "semantic.duplicate",
        ),
        (
            "layer submission { state idle initial {} state loading when true {} }",
            "semantic.layer-state",
        ),
    ] {
        let result = compile(&format!("motion submit {{ {layer} }}"), true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code),
            "{layer}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn layer_style_targets_reject_animation_metadata_and_frame_offsets() {
    for declaration in ["@tween: 100ms", "50%: 1"] {
        for body in [
            format!("body {{ {declaration} }}"),
            format!("state idle initial {{ body {{ {declaration} }} }}"),
        ] {
            let result = compile(
                &format!("motion button {{ layer base {{ {body} }} }}"),
                true,
            );

            assert!(result.diagnostics.iter().any(|diagnostic| matches!(
                diagnostic.code.as_str(),
                "syntax.expected" | "semantic.declaration"
            )));
        }
    }
}

#[test]
fn animation_target_names_do_not_enter_style_context() {
    for target in ["state", "layer"] {
        valid(&format!(
            "motion button {{ layer base {{ state idle initial {{ {target} {{ opacity: 1 }} }} @tween(duration: 100) transition idle -> idle when true {{ {target} {{ opacity {{ 0%: 0 }} }} }} }} }}"
        ));
    }
}

#[test]
fn guarded_transitions_keep_declaration_order_and_layer_local_references() {
    let result = valid(
        "motion submit(loading: boolean, completed: boolean) { layer submission { state idle initial {} state loading {} state success {} transition idle -> loading when loading\n transition loading -> success when completed\n } }",
    );
    let transitions = &result.definitions[0].layers[0].transitions;

    assert_eq!(transitions.len(), 2);
    assert_eq!(transitions[0].from, "idle");
    assert_eq!(transitions[1].to, "success");
}

#[test]
fn guarded_transitions_validate_guards_and_state_references() {
    for (transition, code) in [
        ("transition idle -> missing when true", "semantic.reference"),
        ("transition idle -> idle when 1", "semantic.expression"),
        ("transition idle -> idle {}", "semantic.layer-transition"),
    ] {
        let result = compile(
            &format!(
                "motion submit {{ layer submission {{ state idle initial {{}} {transition}\n }} }}"
            ),
            true,
        );

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code),
            "{transition}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn directional_tracks_support_decorators_interpolation_and_implicit_destinations() {
    let result = valid(
        "motion panel(opened: boolean, size: number) { layer visibility { state closed initial { body { opacity: 0; scale: .9 } } state open { body { opacity: 1; scale: 1 } } transition closed -> open when opened { @spring(stiffness: 400, damping: 25) body { scale { 0%: ${size}; 70%: 1.08 } } } transition open -> closed when !opened { body { opacity: 0 @tween(duration: 150, easing: easeIn) } } } }",
    );
    let transitions = &result.definitions[0].layers[0].transitions;

    assert!(
        transitions[0].transition.targets[0]
            .timing_expression
            .is_some()
    );
    assert_eq!(
        transitions[0].transition.targets[0].properties[0]
            .keyframes
            .as_ref()
            .unwrap()
            .len(),
        2
    );
    assert!(
        transitions[1].transition.targets[0].properties[0]
            .timing_expression
            .is_some()
    );
}
