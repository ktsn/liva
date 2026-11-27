mod support;
use liva_compiler::{
    analysis::{completions, hovers},
    compile,
    expression::parse,
};
use serde_json::json;
use support::valid;

#[test]
fn objects_infer_nested_fields_literals_and_forward_dependencies() {
    let source = r#"motion demo(value: number) {
        let selected = config.nested.property
        let config = { nested: { property: "value" }, amount: later * 2, enabled: true, empty: {}, }
        let later = value
        layer base { content: ${selected}; opacity: ${config.amount} }
    }"#;
    let result = valid(source);
    assert_eq!(result.definitions[0].let_bindings.len(), 3);
    let labels: Vec<_> = hovers(source).into_iter().map(|h| h.label).collect();
    for label in [
        "selected: \"value\"",
        "config.nested.property: \"value\"",
        "config.amount: number",
    ] {
        assert!(labels.iter().any(|found| found == label), "{labels:?}");
    }
    let offset = source.find("config.nested.property").unwrap() + "config.nested.".len();
    let choices = completions(source, offset);
    assert!(
        choices
            .iter()
            .any(|c| c.label == "property" && c.detail == "\"value\""),
        "{choices:?}"
    );
}

#[test]
fn object_ir_preserves_property_order_and_nested_expressions() {
    let value = serde_json::to_value(parse("{ x: 1, nested: { label: 'ok' } }").unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"kind":"object", "properties":[
            {"name":"x", "value":{"kind":"number", "value":1.0}},
            {"name":"nested", "value":{"kind":"object", "properties":[
                {"name":"label", "value":{"kind":"string", "value":"ok"}}
            ]}}
        ]})
    );
}

#[test]
fn object_errors_are_diagnostics_not_panics() {
    for (body, message) in [
        ("let x = { a: 1, a: false }", "Duplicate object property: a"),
        ("let x = { a: missing }", "Unknown variable: missing"),
        ("let x = { a: x }", "Cyclic"),
        (
            "let x = { a: 1 }; let y = x.missing",
            "Unknown variable member",
        ),
        ("let x = { a: 1 }; layer base { opacity: ${x} }", "scalar"),
        ("let x = { a: }", "Expected expression"),
        ("let x = { a 1 }", "Expected colon"),
        ("let x = { a: 1 b: 2 }", "Expected comma"),
        ("let x = { 'a': 1 }", "Expected object property name"),
    ] {
        let result = compile(&format!("motion demo {{ {body} }}"), false);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.message.contains(message)),
            "{body}: {:?}",
            result.diagnostics
        );
        assert!(result.definitions.is_empty());
    }
}

#[test]
fn object_controllers_keep_attachment_validation_and_aliases() {
    valid(
        "motion demo(value: number) { let config = { controller: link(input: value) }; let alias = config; let selected = alias.controller; layer base { opacity := selected } }",
    );
    valid(
        "motion demo(value: number) { let config = { nested: { controller: link(input: value) } }; layer base { opacity := config.nested.controller } }",
    );
    for body in [
        "let config = { controller: link(input: value) }",
        "let config = { controller: link(input: value) }; layer base { opacity := config.controller; scale := config.controller }",
    ] {
        let result = compile(&format!("motion demo(value: number) {{ {body} }}"), false);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == "semantic.controller"),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn inferred_records_can_supply_builtin_record_arguments() {
    valid(
        "motion demo { let vector = { x: 1, y: 2 }; let controller = link(input: vector); layer base { translate := controller } }",
    );
}

#[test]
fn duplicate_object_bindings_with_incompatible_controller_fields_do_not_panic() {
    let result = compile(
        "motion demo { let config = { c: link(input: 1) }; let config = { c: 1 }; layer base { opacity := config.c } }",
        false,
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.message.contains("Duplicate")),
        "{:?}",
        result.diagnostics
    );
}
