use liva_compiler::ir::{CssValue, PropertyValue};
mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn target_defaults_and_property_overrides_lower_timing_expressions() {
    let result = valid(
        "motion button { let quick = tween(duration: 150)\n layer idle { @quick body { opacity: 1; scale: 1 @spring(stiffness: 300) } } }",
    );
    let properties = &result.definitions[0].layers[0].targets[0].properties;

    assert_ne!(
        properties[0].css().unwrap().timing_expression,
        properties[1].css().unwrap().timing_expression
    );
    assert_eq!(
        properties[1].css().unwrap().value,
        PropertyValue::Literal { value: "1".into() }
    );
}

#[test]
fn style_tracks_lower_typed_easing_and_use_the_explicit_destination() {
    let result = valid(
        "motion button(amount: number) { layer idle { body { @tween(duration: 400) translate ~> { 0%: 0 20px; 50%: 0 5px @easeOut; 100%: ${amount}px 0 } } } }",
    );
    let property = &result.definitions[0].layers[0].targets[0].properties[0];
    let PropertyValue::Keyframes { frames } = &property.css().unwrap().value else {
        panic!("Expected a style track")
    };

    assert!(matches!(frames[2].value, CssValue::Template { .. }));
    assert!(frames[1].easing_expression.is_some());
    assert!(frames[1].easing.is_none());
}

#[test]
fn lifecycle_tracks_accept_target_defaults_and_references() {
    let result = valid(
        "motion button { let quick = tween()\nlayer idle { body { opacity: 1 } }\n enter { @quick body { opacity: 0 } }\n leave { @quick body { opacity ~> { 0%: 0 @easeIn; 100%: 1 } } } }",
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
        ("@easeOut body { opacity: 1 }", "easeOut"),
        ("body { opacity: 1 @true }", "true"),
        (
            "body { @tween() opacity ~> { 0%: 0 @spring(); 100%: 1 } }",
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
        "motion button { layer idle { body { @tween() opacity ~> { 0%: 0 } } } }",
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
        "motion button { layer idle { body { opacity: 1 } } enter { @tween(duration: 150) body { @spring(stiffness: 300, damping: 20) opacity ~> { 0%: 0 } } } }",
    );
    let target = &result.definitions[0].enter.as_ref().unwrap().targets[0];
    let property = &target.properties[0];

    assert!(property.timing.is_none());
    assert!(property.timing_expression.is_some());
    assert_ne!(property.timing_expression, target.timing_expression);
}

#[test]
fn final_frame_easing_warns_without_discarding_the_definition() {
    for body in [
        "layer base { body { @tween() opacity ~> { 100%: 1 @easeOut; 0%: 0 } } }",
        "layer base { body { opacity: 1 } } @tween() enter { body { opacity ~> { 100%: 1 @easeOut; 0%: 0 } } }",
        "layer base { body { opacity: 1 } state off initial {} state on {} @tween() transition off -> on when true { body { opacity ~> { 100%: 1 @easeOut; 0%: 0 } } } }",
    ] {
        let source = format!("motion sample {{ {body} }}");
        let result = compile(&source, true);
        let warning = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.final-frame-easing")
            .unwrap();

        assert_eq!(warning.severity, "warning");
        assert_eq!(&source[warning.range.start..warning.range.end], "@easeOut");
        assert_eq!(result.definitions.len(), 1, "{:?}", result.diagnostics);
    }
}

#[test]
fn last_explicit_frame_easing_can_lead_to_an_implicit_endpoint() {
    let result = valid(
        "motion sample { layer base { body { opacity: 1 } } @tween() enter { body { opacity ~> { 50%: 0 @easeOut } } } }",
    );

    assert!(result.diagnostics.is_empty());
    assert!(
        result.definitions[0].enter.as_ref().unwrap().targets[0].properties[0]
            .keyframes
            .as_ref()
            .unwrap()[0]
            .easing_expression
            .is_some()
    );
}
