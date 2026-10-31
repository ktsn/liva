use liva_compiler::{compile, ir::Timing};

fn valid(source: &str) -> liva_compiler::Compilation {
    let result = compile(source, true);
    assert!(
        !result.diagnostics.iter().any(|d| d.severity == "error"),
        "{:?}",
        result.diagnostics
    );
    result
}

fn animation(timing: &str) -> String {
    format!(
        "motion a(checked: boolean) {{ state off {{ t {{ opacity: 0 }} }} state on when checked {{ t {{ opacity: 1 }} }} transition {{ {timing}\n }} }}"
    )
}

#[test]
fn motion_examples_compile_to_ordered_let_bindings_conditions_and_templates() {
    let toggle = valid(include_str!("../../../fixtures/reactive-toggle.liv"));
    assert_eq!(toggle.definitions[0].parameters.len(), 1);
    assert_eq!(toggle.definitions[0].states[1].name, "on");
    assert!(toggle.definitions[0].states[1].when.is_some());

    let card = valid(include_str!("../../../fixtures/card.liv"));
    let property = &card.definitions[0].states[1].targets[0].properties[0];
    assert_eq!(property.template.as_ref().unwrap().len(), 4);
    assert_eq!(
        property.value,
        "${movement.offset.x}px ${movement.offset.y}px"
    );
}

#[test]
fn declaration_order_normalizes_complete_timing_families() {
    for (input, expected) in [
        (
            "@tween: 350ms ease-out; @tween-duration: 200ms",
            Timing::Tween {
                duration_ms: 200.0,
                easing: "ease-out".into(),
            },
        ),
        (
            "@tween-easing: ease-in; @tween: 0.5s",
            Timing::Tween {
                duration_ms: 500.0,
                easing: "linear".into(),
            },
        ),
        (
            "@spring: 300 20 2; @spring: 350ms 0.2",
            Timing::SpringDuration {
                duration_ms: 350.0,
                bounce: 0.2,
            },
        ),
        (
            "@spring-duration: 100ms; @spring: 300 20",
            Timing::SpringPhysics {
                stiffness: 300.0,
                damping: 20.0,
                mass: 1.0,
            },
        ),
        (
            "@spring: 350ms 0.2; @tween-duration: 200ms; @tween-easing: steps(4, end)",
            Timing::Tween {
                duration_ms: 200.0,
                easing: "steps(4, end)".into(),
            },
        ),
    ] {
        let result = valid(&animation(input));
        assert_eq!(
            result.definitions[0]
                .general_transition
                .as_ref()
                .unwrap()
                .timing
                .as_ref(),
            Some(&expected),
            "{input}"
        );
    }

    for input in [
        "@spring-duration: 100ms; @spring-stiffness: 200",
        "@spring: 300 20 1; @spring-bounce: 0.2",
        "@spring: 0ms",
        "@spring: 100ms 1",
        "@tween: -1ms",
        "@tween: 10",
    ] {
        let result = compile(&animation(input), false);
        assert!(result.definitions.is_empty(), "{input}");
    }
}

#[test]
fn expression_types_references_and_fallback_are_validated() {
    for condition in [
        "checked && !false",
        "(1 + 2 * 3) == 7",
        "'a' != \"b\"",
        "checked || 1 / 0 > 0",
    ] {
        valid(&animation("@tween: 1ms").replace("when checked", &format!("when {condition}")));
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
                &animation("@tween: 1ms").replace("when checked", &format!("when {condition}")),
                false
            )
            .definitions
            .is_empty(),
            "{condition}"
        );
    }

    for source in [
        "motion a { state first {} state second {} }",
        "motion a { state first when true {} }",
        "motion a { let movement = drag(target: missing); state idle {} }",
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
fn inline_frames_preserve_css_easing_and_replace_inheritance() {
    let source = animation(
        "@tween: 100ms linear(0, 0.3 50%, 1); t { opacity { 70%: 0.8 @ steps(2, end); 40%: 0.2 @ cubic-bezier(0.2, 0.8, 0.2, 1) } }",
    );
    let result = valid(&source);
    let frames = result.definitions[0]
        .general_transition
        .as_ref()
        .unwrap()
        .targets[0]
        .properties[0]
        .keyframes
        .as_ref()
        .unwrap();
    assert_eq!(frames[0].offset, 0.4);
    assert_eq!(frames[1].easing.as_deref(), Some("steps(2, end)"));
    assert!(
        compile(
            &source.replace("@tween: 100ms linear(0, 0.3 50%, 1)", "@spring: 300 20 1"),
            false
        )
        .definitions
        .is_empty()
    );
}

#[test]
fn track_edits_preserve_surrounding_source() {
    use liva_compiler::edits::{Edit, FrameEdit, apply_edits};
    let source = include_str!("../../../fixtures/reactive-toggle.liv").replace('\n', "\r\n");
    let path = "toggle/transition/general/target/thumb/property/scale";
    let result = apply_edits(
        &source,
        &[Edit::Track {
            path: path.into(),
            timing: Some("@tween: 200ms ease-in".into()),
            frames: Some(vec![FrameEdit {
                offset: 0.5,
                value: "1.2 1".into(),
                easing: Some("steps(2, end)".into()),
            }]),
        }],
    )
    .unwrap();
    let old = compile(&source, true).mappings.unwrap()[path].range.clone();
    let new = result.compilation.mappings.unwrap()[path].range.clone();

    assert_eq!(&source[..old.start], &result.source[..new.start]);
    assert_eq!(&source[old.end..], &result.source[new.end..]);
    assert!(result.source.contains("50%: 1.2 1 @ steps(2, end)"));
}

#[test]
fn let_arguments_scope_and_whitespace_are_checked() {
    valid(
        &animation("@tween: 1ms")
            .replace("checked: boolean", "checked /* input */ :\tboolean")
            .replace("when checked", "when\tchecked"),
    );

    valid(&include_str!("../../../fixtures/card.liv").replace("let movement", "let\tmovement"));

    for source in [
        "motion a { state idle { let movement = drag(target: body); } }",
        "let movement = drag(target: body); motion a { state idle {} }",
        "motion a { state idle {} transition { let movement = drag(target: body); } }",
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
fn inline_frame_field_edits_preserve_comments_or_reject() {
    use liva_compiler::edits::{Edit, apply_edits};
    let source = include_str!("../../../fixtures/reactive-toggle.liv");
    let path = "toggle/transition/general/target/thumb/property/scale/frame/0.4/value";
    let edit = Edit::Set {
        path: path.into(),
        value: "1.5 1".into(),
    };
    let result = apply_edits(source, &[edit]).unwrap();
    assert_eq!(result.source, source.replacen("1.3 1", "1.5 1", 1));

    let source = source.replace("40%: 1.3 1", "40%: /* 😀 preserve */ 1.3 1");
    let edit = Edit::Set {
        path: path.into(),
        value: "1.5 1".into(),
    };
    assert!(
        apply_edits(&source, &[edit])
            .unwrap_err()
            .contains("comments")
    );
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
        state idle { body { translate: ${progress + movement.offset.x}px 0; content: ${label} } }
        state active when enabled && label != "" { body { translate: ${progress}px 0; content: ${label} } }
        transition { @tween: 100ms }
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
        let result = valid(&format!("{header} {{ state idle {{}} }}"));
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
        "motion a(bad-name: number)",
        "motion a(value: number = 1)",
        "motion a(value: number)(other: string)",
        "motion a()suffix",
        "motion ()a",
    ] {
        let result = compile(&format!("{header} {{ state idle {{}} }}"), false);

        assert!(result.definitions.is_empty(), "{header}");
        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "{header}"
        );
    }

    for body in [
        "let value = drag(target: body); state idle { body { opacity: 1 } }",
        "state idle when number {}",
        "state idle { body { opacity: ${missing} } }",
        "state idle { body { opacity: ${value.member} } }",
    ] {
        let result = compile(&format!("motion a(value: number) {{ {body} }}"), false);
        assert!(result.definitions.is_empty(), "{body}");
    }

    let result = compile(
        "motion a(value: boolean) { state idle {} } motion b { state idle {} state active when value {} }",
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
fn definition_names_are_unique_independently_of_parameters() {
    let result = compile(
        "motion a(value: number) { state idle {} } motion a(flag: boolean) { state idle {} }",
        false,
    );

    assert!(result.definitions.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate")
    );
}

#[test]
fn let_initializers_use_function_calls_and_builtin_signatures() {
    let result = valid(
        "motion card { let movement=drag(\n target: card_body,\n)\n state idle { card_body { translate: ${movement.offset.x}px 0 } } }",
    );
    let initializer = serde_json::to_value(&result.definitions[0].let_bindings[0]).unwrap();

    assert_eq!(
        initializer,
        serde_json::json!({
            "name": "movement",
            "initializer": {
                "kind": "call",
                "function": "drag",
                "arguments": [{ "name": "target", "value": { "kind": "reference", "path": ["card_body"] } }],
            },
        })
    );

    for (call, message) in [
        ("unknown(target: body)", "Unknown function"),
        ("drag()", "Missing argument"),
        ("drag(element: body)", "Unknown argument"),
        ("drag(target: body, target: body)", "Duplicate argument"),
        ("drag(target: 1)", "Invalid argument type"),
        ("drag(target: true)", "Invalid argument type"),
        ("drag(target: 'body')", "Invalid argument type"),
        ("drag(target: absent)", "Unknown variable"),
        ("drag(target: enabled)", "Invalid argument type"),
        ("drag(target: body.active)", "Unknown variable member"),
        ("drag(target: drag(target: body))", "Invalid argument type"),
    ] {
        let source = format!(
            "motion card(enabled: boolean) {{ let movement = {call}; state idle {{ body {{ opacity: 1 }} }} }}"
        );
        let result = compile(&source, true);

        assert!(result.definitions.is_empty(), "{call}");
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.expression")
            .unwrap();
        assert!(
            diagnostic.message.contains(message),
            "{call}: {}",
            diagnostic.message
        );
        assert!(source[diagnostic.range.start..diagnostic.range.end].starts_with("let movement"));
    }
}

#[test]
fn calls_parse_without_resolving_function_names() {
    use liva_compiler::expression::{Expression, parse};

    let expression = parse("custom(value: 1 + 2, nested: other(flag: true),)").unwrap();
    let Expression::Call {
        function,
        arguments,
    } = expression
    else {
        panic!("Expected a call")
    };

    assert_eq!(function, "custom");
    assert_eq!(arguments.len(), 2);
    assert!(matches!(arguments[0].value, Expression::Binary { .. }));
    assert!(matches!(arguments[1].value, Expression::Call { .. }));

    for text in [
        "custom(1)",
        "custom(value:)",
        "custom(value: 1,,)",
        "custom(value: 1) suffix",
    ] {
        assert!(parse(text).is_err(), "{text}");
    }
}

#[test]
fn target_variables_share_motion_scope_and_use_reference_expressions() {
    let result = valid(
        "motion card { let movement = drag(target: (body)); state idle { body { opacity: 1 } } }",
    );
    let initializer =
        serde_json::to_value(&result.definitions[0].let_bindings[0].initializer).unwrap();

    assert_eq!(
        initializer["arguments"][0]["value"],
        serde_json::json!({ "kind": "reference", "path": ["body"] })
    );

    for (source, code) in [
        (
            "motion card(body: string) { state idle { body { opacity: 1 } } }",
            "semantic.duplicate",
        ),
        (
            "motion card { let body = drag(target: other); state idle { body { opacity: 1 } other { opacity: 1 } } }",
            "semantic.duplicate",
        ),
        (
            "motion card(body: string) { let movement = drag(target: body); state idle { other { opacity: 1 } } }",
            "semantic.expression",
        ),
        (
            "motion card { state idle { body { opacity: ${body} } } }",
            "semantic.expression",
        ),
        (
            "motion card { state idle { body { opacity: ${body + 1} } } }",
            "semantic.expression",
        ),
        (
            "motion card { state idle {} state active when body { body { opacity: 1 } } }",
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
        "motion first { state idle { body { opacity: 1 } } } motion second { let movement = drag(target: body); state idle { other { opacity: 1 } } }",
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
        state idle { body { translate: ${doubled}px ${offset.y}px; } }
        state moving when active { body { translate: ${doubled}px ${offset.y}px; } }
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
        let source = format!("motion example {{ {declarations} state idle {{}} }}");
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
