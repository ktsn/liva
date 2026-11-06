mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn target_defaults_and_property_overrides_lower_timing_expressions() {
    let result = valid(
        "motion button { let quick = tween(duration: 150)\n layer idle { body @quick { opacity: 1; scale: 1 @spring(stiffness: 300) } } }",
    );
    let properties = &result.definitions[0].layers[0].targets[0].properties;

    assert_ne!(
        properties[0].timing_expression,
        properties[1].timing_expression
    );
    assert_eq!(properties[1].value, "1");
}

#[test]
fn style_tracks_lower_typed_easing_and_use_the_explicit_destination() {
    let result = valid(
        "motion button(amount: number) { layer idle { body { translate @tween(duration: 400) { 0%: 0 20px; 50%: 0 5px @easeOut; 100%: ${amount}px 0 } } } }",
    );
    let property = &result.definitions[0].layers[0].targets[0].properties[0];
    let frames = property.keyframes.as_ref().unwrap();

    assert_eq!(property.value, "${amount}px 0");
    assert!(property.template.is_some());
    assert!(frames[1].easing_expression.is_some());
    assert!(frames[1].easing.is_none());
}

#[test]
fn lifecycle_tracks_accept_target_defaults_and_references() {
    let result = valid(
        "motion button { let quick = tween()\nlayer idle { body { opacity: 1 } }\n enter { body @quick { opacity: 0 } }\n leave { body @quick { opacity { 0%: 0 @easeIn; 100%: 1 } } } }",
    );
    let definition = &result.definitions[0];

    assert!(
        definition.enter.as_ref().unwrap().targets[0]
            .timing_expression
            .is_some()
    );
    assert!(
        definition.leave.as_ref().unwrap().targets[0]
            .timing_expression
            .is_some()
    );
}

#[test]
fn decorators_enforce_position_types_with_source_ranges() {
    for (body, expression) in [
        ("body @easeOut { opacity: 1 }", "easeOut"),
        ("body { opacity: 1 @true }", "true"),
        (
            "body { opacity @tween() { 0%: 0 @spring(); 100%: 1 } }",
            "spring()",
        ),
        ("body { opacity: 1 @missing }", "missing"),
    ] {
        let source = format!("motion button {{ layer idle {{ {body} }} }}");
        let result = compile(&source, true);
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.expression")
            .unwrap();

        assert!(
            source[diagnostic.range.start..diagnostic.range.end].contains(expression),
            "{diagnostic:?}"
        );
    }
}

#[test]
fn style_tracks_require_an_explicit_final_style() {
    let result = compile(
        "motion button { layer idle { body { opacity @tween() { 0%: 0 } } } }",
        true,
    );

    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.endpoint")
    );
}

#[test]
fn typed_property_timing_overrides_a_typed_target_default() {
    let result = valid(
        "motion button { layer idle { body { opacity: 1 } } enter { body @tween(duration: 150) { opacity @spring(stiffness: 300, damping: 20) { 0%: 0 } } } }",
    );
    let target = &result.definitions[0].enter.as_ref().unwrap().targets[0];
    let property = &target.properties[0];

    assert!(property.timing.is_none());
    assert!(property.timing_expression.is_some());
    assert_ne!(property.timing_expression, target.timing_expression);
}
