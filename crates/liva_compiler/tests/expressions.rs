mod support;
use liva_compiler::compile;
use support::valid;

#[test]
fn layer_conditions_accept_boolean_expressions_and_reject_invalid_types() {
    for condition in [
        "checked && !false",
        "(1 + 2 * 3) == 7",
        "'a' != \"b\"",
        "checked || 1 / 0 > 0",
    ] {
        valid(&format!(
            "motion a(checked: boolean) {{ layer idle {{}} layer active when {condition} {{}} }}"
        ));
    }

    for condition in [
        "unknown",
        "checked.value",
        "checked + 1",
        "movement.active",
        "checked()",
        "${checked}",
        "1",
    ] {
        assert!(
            compile(
                &format!("motion a(checked: boolean) {{ layer idle {{}} layer active when {condition} {{}} }}"),
                false
            )
            .definitions
            .is_empty(),
            "{condition}"
        );
    }
}

#[test]
fn bindings_belong_directly_to_a_motion() {
    for source in [
        "motion a { layer idle { let movement = drag(target: body); } }",
        "let movement = drag(target: body); motion a { layer idle {} }",
        "motion a { layer idle {} enter { let movement = drag(target: body); } }",
    ] {
        assert!(
            compile(source, false)
                .diagnostics
                .iter()
                .any(|d| d.severity == "error"),
            "{source}"
        );
    }
}

#[test]
fn typed_parameters_are_declarations_and_share_expression_scope_with_let_bindings() {
    let result = valid(
        r#"motion progress(
        progress: number,
        enabled: boolean,
        label: string,
    ) {
        let movement = drag(target: body)
        layer idle { body { translate: ${progress + movement.offset.x}px 0; content: ${label} } }
        layer active when enabled && label != "" { body { translate: ${progress}px 0; content: ${label} } }
          }"#,
    );
    let json = serde_json::to_value(&result.definitions[0]).unwrap();

    assert_eq!(
        json["parameters"],
        serde_json::json!([
            {"name": "progress", "type": "number"},
            {"name": "enabled", "type": "boolean"},
            {"name": "label", "type": "string"},
        ])
    );
    assert_eq!(result.definitions[0].let_bindings.len(), 1);

    for header in [
        "motion empty",
        "motion empty()",
        "motion empty(motion: number)",
    ] {
        let result = valid(&format!("{header} {{ layer idle {{}} }}"));
        assert_eq!(
            result.definitions[0].parameters.len(),
            usize::from(header.contains("number"))
        );
    }
}

#[test]
fn invalid_parameter_declarations_are_diagnosed() {
    for header in [
        "fn example(value: number)",
        "motion a(value)",
        "motion a(value:)",
        "motion a(: number)",
        "motion a(value: unknown)",
        "motion a(value: number, value: boolean)",
        "motion a(value: number enabled: boolean)",
        "motion a(value: number,,)",
        "motion a(true: boolean)",
        "motion a(value: number = 1)",
        "motion a(value: number)(other: string)",
        "motion a()suffix",
        "motion ()a",
    ] {
        let result = compile(&format!("{header} {{ layer idle {{}} }}"), false);

        assert!(result.definitions.is_empty(), "{header}");
        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "{header}"
        );
    }
}

#[test]
fn parameters_are_local_and_cannot_be_redeclared_as_bindings() {
    let shadowed = compile(
        "motion a(value: number) { let value = 1; layer idle {} }",
        false,
    );
    assert!(shadowed.definitions.is_empty());
    assert!(
        shadowed
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate")
    );

    let result = compile(
        "motion a(value: boolean) { layer idle {} } motion b { layer idle {} layer active when value {} }",
        false,
    );
    assert_eq!(result.definitions.len(), 1);
    assert_eq!(result.definitions[0].name, "a");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "semantic.expression")
    );
}

#[test]
fn target_variables_share_motion_scope_and_use_reference_expressions() {
    let result = valid(
        "motion card { let movement = drag(target: (body)); layer idle { body { opacity: 1 } } }",
    );
    let initializer =
        serde_json::to_value(&result.definitions[0].let_bindings[0].initializer).unwrap();

    assert_eq!(
        initializer["arguments"][0]["value"],
        serde_json::json!({ "kind": "reference", "path": ["body"] })
    );

    for (source, code) in [
        (
            "motion card(body: string) { layer idle { body { opacity: 1 } } }",
            "semantic.duplicate",
        ),
        (
            "motion card { let body = drag(target: other); layer idle { body { opacity: 1 } other { opacity: 1 } } }",
            "semantic.duplicate",
        ),
        (
            "motion card(body: string) { let movement = drag(target: body); layer idle { other { opacity: 1 } } }",
            "semantic.expression",
        ),
    ] {
        let result = compile(source, false);

        assert!(result.definitions.is_empty(), "{source}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code),
            "{source}: {:?}",
            result.diagnostics
        );
    }

    let result = compile(
        "motion first { layer idle { body { opacity: 1 } } } motion second { let movement = drag(target: body); layer idle { other { opacity: 1 } } }",
        false,
    );

    assert_eq!(result.definitions.len(), 1);
    assert_eq!(result.definitions[0].name, "first");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message == "Unknown variable: body")
    );
}

#[test]
fn let_expressions_infer_types_and_resolve_dependencies() {
    let result = valid(
        r#"motion derived(progress: number) {
        let doubled = base * 2;
        let base = progress + 1;
        let selected = body;
        let movement = drag(target: selected);
        let offset = movement.offset;
        let active = movement.active;
        let label = "ready";
        let constant = 42;
        layer idle { body { translate: ${doubled}px ${offset.y}px; } }
        layer moving when active { body { translate: ${doubled}px ${offset.y}px; } }
    }"#,
    );

    assert_eq!(result.definitions[0].let_bindings.len(), 8);
    assert_eq!(result.definitions[0].let_bindings[0].name, "doubled");

    for (declarations, message) in [
        ("let a = a;", "Cyclic let binding dependency"),
        ("let a = b; let b = a;", "Cyclic let binding dependency"),
        ("let a = missing * 2;", "Unknown variable"),
        (
            "let a = true; let b = a * 2;",
            "Incompatible expression operands",
        ),
    ] {
        let source = format!("motion example {{ {declarations} layer idle {{}} }}");
        let result = compile(&source, true);

        assert!(result.definitions.is_empty(), "{source}");
        assert!(
            result.diagnostics.iter().any(|diagnostic| diagnostic
                .message
                .to_lowercase()
                .contains(&message.to_lowercase())),
            "{:?}",
            result.diagnostics
        );
    }
}
