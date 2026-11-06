mod support;

use liva_compiler::{analysis, compile};
use support::valid;

#[test]
fn timing_and_easing_bindings_are_typed_and_lower_to_expressions() {
    let source = "motion button {\nlet curve = cubicBezier(x1: 0.2, y1: 0, x2: 0, y2: 1)\nlet quick = tween(duration: 150, easing: curve)\nlet bounce = spring(stiffness: 400, damping: 20)\nstate idle {}\n}";
    let result = valid(source);

    assert_eq!(result.definitions[0].let_bindings.len(), 3);

    let hovers = analysis::hovers(source);

    assert!(hovers.iter().any(|hover| hover.label.contains("timing")));
    assert!(hovers.iter().any(|hover| hover.label.contains("easing")));
}

#[test]
fn easing_constants_and_default_timing_arguments_are_accepted() {
    for initializer in ["tween()", "spring()", "tween(easing: easeOut)", "easeInOut"] {
        valid(&format!(
            "motion button {{ let value = {initializer}\n state idle {{}} }}"
        ));
    }
}

#[test]
fn timing_calls_reject_wrong_argument_types_and_unknown_parameters() {
    for initializer in [
        "tween(duration: '150ms')",
        "tween(easing: 'ease-out')",
        "spring(stiffness: true)",
        "tween(easing: spring())",
        "spring(duration: 200)",
        "cubicBezier(x1: 0.2)",
        "tween(duration: 1, duration: 2)",
    ] {
        let result = compile(
            &format!("motion button {{ let value = {initializer}\n state idle {{}} }}"),
            true,
        );

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.expression"),
            "{initializer}"
        );
    }
}

#[test]
fn timing_values_cannot_be_used_as_css_scalars_or_conditions() {
    for body in [
        "state idle { body { opacity: ${tween()} } }",
        "state idle {} state active when spring() {}",
    ] {
        let result = compile(&format!("motion button {{ {body} }}"), true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.expression")
        );
    }
}
