mod support;

use liva_compiler::{analysis, compile};
use support::valid;

#[test]
fn timing_and_easing_bindings_are_typed_and_lower_to_expressions() {
    let source = "motion button {\nlet curve = cubicBezier(x1: 0.2, y1: 0, x2: 0, y2: 1)\nlet quick = tween(duration: 150, easing: curve)\nlet bounce = spring(stiffness: 400, damping: 20)\nlayer idle {}\n}";
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
            "motion button {{ let value = {initializer}\n layer idle {{}} }}"
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
        "cubicBezier(x1: 0.2)",
        "tween(duration: 1, duration: 2)",
    ] {
        let result = compile(
            &format!("motion button {{ let value = {initializer}\n layer idle {{}} }}"),
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
        "layer idle { body { opacity: ${tween()} } }",
        "layer idle {} layer active when spring() {}",
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

#[test]
fn spring_signatures_accept_direct_and_bound_timing_values() {
    for call in [
        "spring()",
        "spring(stiffness: 300)",
        "spring(duration: 400)",
        "spring(duration: 400, bounce: 0.25)",
    ] {
        let source = format!(
            "motion sample {{ let timing = {call}\nlayer base {{ body {{ opacity: 1 @{call}\nscale: 1 @timing }} }} }}"
        );
        valid(&source);
    }
}

#[test]
fn overloaded_calls_explain_the_invalid_argument() {
    for (call, message) in [
        (
            "spring(bounce: 0.25)",
            "Missing argument for spring: duration",
        ),
        (
            "spring(duration: 400, damping: 20)",
            "Incompatible argument groups for spring",
        ),
        (
            "spring(duration: '400')",
            "Invalid argument type for spring.duration",
        ),
        (
            "spring(bounce: 0.1, bounce: 0.2)",
            "Duplicate argument: bounce",
        ),
        ("spring(speed: 2)", "Unknown argument for spring: speed"),
        (
            "steps(count: true)",
            "Invalid argument type for steps.count",
        ),
        (
            "steps(count: 4, position: 1)",
            "Invalid argument type for steps.position",
        ),
        ("steps(number: 4)", "Unknown argument for steps: number"),
    ] {
        let source = format!("motion sample {{ let timing = {call}\nlayer base {{}} }}");
        let result = compile(&source, true);

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains(message)),
            "{call}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn step_easing_accepts_constants_calls_bindings_and_dynamic_arguments() {
    for easing in [
        "stepStart",
        "stepEnd",
        "steps(count: n)",
        "steps(count: n, position: position)",
        "steps(count: 3, position: 'jump-none')",
    ] {
        let source = format!(
            "motion sample(n: number, position: string) {{ let curve = {easing}\nlayer base {{ body {{ @tween(duration: 100, easing: curve) opacity ~> {{ 0%: 0 @curve\n100%: 1 }} }} }} }}"
        );
        valid(&source);
    }
}

#[test]
fn step_easing_type_checks_without_validating_argument_values() {
    for easing in [
        "steps(count: 4, position: 'middle')",
        "steps(count: 4, position: position)",
        "steps(count: 0)",
    ] {
        let source = format!(
            "motion sample {{ let position = 'middle'\nlet curve = {easing}\nlayer base {{ body {{ opacity: 1 @tween(easing: curve) }} }} }}"
        );

        valid(&source);
    }
}

#[test]
fn spring_hover_lists_each_signature_and_optional_parameters() {
    let source = "motion sample { let timing = spring(duration: 400)\nlayer base {} }";
    let hovers = analysis::hovers(source);
    let hover = hovers
        .iter()
        .find(|hover| hover.label.starts_with("spring("))
        .unwrap();

    assert!(
        hover
            .label
            .contains("spring(duration: number, bounce?: number): timing")
    );
    assert!(
        hover
            .label
            .contains("spring(stiffness?: number, damping?: number, mass?: number): timing")
    );
}
