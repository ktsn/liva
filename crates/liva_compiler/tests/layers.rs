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
    assert!(definition.states.is_empty());
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
fn layers_do_not_disable_legacy_fallback_validation() {
    for states in ["state hover when true {}", "state first {} state second {}"] {
        let source = format!("motion button {{ layer base {{}} {states} }}");
        let result = compile(&source, true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.fallback")
        );
    }
}
