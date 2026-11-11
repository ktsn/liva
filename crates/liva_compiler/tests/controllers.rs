use liva_compiler::ir::PropertyValue;
mod support;

use liva_compiler::compile;
use liva_syntax::Diagnostic;
use support::valid;

fn single_controller_error(source: &str) -> Diagnostic {
    let result = compile(source, true);

    assert!(result.definitions.is_empty(), "{source}");
    assert_eq!(
        result.diagnostics.len(),
        1,
        "{source}: {:?}",
        result.diagnostics
    );
    let diagnostic = result.diagnostics.into_iter().next().unwrap();

    assert_eq!(diagnostic.code, "semantic.controller");

    diagnostic
}

#[test]
fn scalar_vector_and_inline_controllers_are_typed_and_attached() {
    valid(
        r#"motion resize(input: number) {
      let widthControl = link(input: input)
      let widthAlias = widthControl
      let offset = link(input: input, component: "y", sensitivity: -1)
      let projected = offset.value.y + offset.velocity.y * 200
      layer base { width: 240px; translate: 0 0; state closed initial {} state open {} transition closed -> open when signal.released && projected > 100 }
      let signal = drag(target: self)
      layer dragging when signal.active { width := widthAlias; translate := offset; rotate := link(input: input, sensitivity: .5) }
    }"#,
    );

    valid(
        r#"motion dragger {
      let pointer = drag(target: self)
      let movement = link(input: pointer.offset)
      layer base { translate: 0 0 }
      layer active when pointer.active { translate := movement }
    }"#,
    );
}

#[test]
fn controller_attachments_reject_invalid_types_and_cycles() {
    for body in [
        "let c = link(input: 1, component: 1); layer base { translate := c }",
        "layer base { width := 10 }",
        "let c = link(input: c.value); layer base { width := c }",
        "let a = link(input: b.value); let b = link(input: a.value); layer base { width := a; height := b }",
    ] {
        let result = compile(&format!("motion example {{ {body} }}"), true);

        assert!(
            result.definitions.is_empty(),
            "{body}: {:?}",
            result.diagnostics
        );
        assert!(!result.diagnostics.is_empty(), "{body}");
    }
}

#[test]
fn invalid_attachments_do_not_suppress_decorator_recovery_diagnostics() {
    let result = compile(
        "motion example { layer base { @tween(duration: missing) width := 1 } }",
        true,
    );

    assert!(result.definitions.is_empty());
    let messages: Vec<_> = result
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.as_str())
        .collect();

    assert!(messages.contains(&":= requires a property controller"));
    assert!(messages.contains(&"Unknown variable: missing"));
}

#[test]
fn same_address_declarations_share_a_controller_and_inline_calls_lower_to_independent_lets() {
    let result = valid(
        r#"motion example(input: number) {
      let c = link(input: input)
      layer base { width := c }
      layer active when input > 0 { width := c; height := link(input: input) }
    }"#,
    );
    let definition = &result.definitions[0];

    assert_eq!(definition.let_bindings.len(), 2);
    assert!(matches!(
        definition.layers[0].targets[0].properties[0].value,
        PropertyValue::Binding { .. }
    ));
}

#[test]
fn keyframes_reject_controller_attachments_in_styles_and_animations() {
    for body in [
        "@spring() layer base { width ~> { 100% := c } }",
        "layer base { state a initial { width: 10px } state b { width: 20px } @tween() transition a -> b when true { width ~> { 100% := c } } }",
        "layer base { width: 10px } @tween() enter { width ~> { 0% := c } }",
        "layer base { width: 10px } @tween() leave { width ~> { 100% := c } }",
    ] {
        let result = compile(
            &format!("motion example {{ let c = link(input: 1); {body} }}"),
            true,
        );

        assert!(result.definitions.is_empty(), "{body}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.controller"),
            "{body}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn binding_compilation_does_not_restrict_properties_by_controller_shape() {
    for (body, property) in [
        (
            "let c = link(input: 1); layer base { translate := c }",
            "translate",
        ),
        (
            "let p = drag(target: self); let c = link(input: p.offset); layer base { width := c }",
            "width",
        ),
        (
            "let c = link(input: 1); layer base { opacity := c }",
            "opacity",
        ),
        (
            "let c = link(input: 1); layer base { background-color := c }",
            "background-color",
        ),
        (
            "let c = link(input: 1); layer base { --progress := c }",
            "--progress",
        ),
    ] {
        let result = valid(&format!("motion example {{ {body} }}"));
        let target = &result.definitions[0].layers[0].targets[0];

        assert_eq!(target.name, "self");
        assert_eq!(target.properties[0].name, property);
        assert_eq!(
            serde_json::to_value(&target.properties[0].value).unwrap(),
            serde_json::json!({
                "kind": "binding",
                "expression": {"kind": "reference", "path": ["c"]}
            })
        );
    }
}

#[test]
fn every_controller_definition_requires_a_binding_even_without_observations() {
    for body in [
        "let c = link(input: 1); layer base {}",
        "let c = link(input: 1); let value = c.value; layer base { width: 100px }",
        "let alias = (c); let c = link(input: 1); let other = alias; layer base {}",
    ] {
        let source = format!("motion example {{ {body} }}");
        let diagnostic = single_controller_error(&source);

        assert_eq!(diagnostic.message, "Controller is not bound to a property");
        assert_eq!(
            &source[diagnostic.range.start..diagnostic.range.end],
            "link(input: 1)"
        );
    }
}

#[test]
fn controller_aliases_and_repeated_bindings_resolve_forward_to_one_origin() {
    let result = valid(
        "motion example { layer base { width := later; state idle initial { self { width := original } } state active { width := (middle) } } let later = (middle); let middle = original; let original = (link(input: 1)); let unused = later }",
    );
    let definition = &result.definitions[0];
    let bindings = serde_json::to_value(&definition.let_bindings).unwrap();

    assert_eq!(definition.let_bindings.len(), 4);
    assert_eq!(
        bindings[0]["initializer"],
        serde_json::json!({"kind": "reference", "path": ["middle"]})
    );
    assert_eq!(
        bindings[2]["initializer"],
        serde_json::json!({
            "kind": "call",
            "function": "link",
            "arguments": [{"name": "input", "value": {"kind": "number", "value": 1.0}}]
        })
    );
}

#[test]
fn one_controller_cannot_acquire_distinct_addresses_through_aliases_or_states() {
    for declarations in [
        "layer base { width := c; height := alias }",
        "layer base { width := c; other { width := alias } }",
        "layer base { state idle initial { width := c } state active { height := alias } }",
    ] {
        let source =
            format!("motion example {{ let alias = c; let c = link(input: 1); {declarations} }}");
        let diagnostic = single_controller_error(&source);

        assert_eq!(
            diagnostic.message,
            "A controller may attach to exactly one target/property address"
        );
        assert!(source[diagnostic.range.start..diagnostic.range.end].contains(":= alias"));
    }
}

#[test]
fn inline_controllers_keep_independent_scope_identities_and_root_target_addresses() {
    let result = valid(
        r#"motion example {
          layer base {
            width := link(input: 1)
            other { height := link(input: 2) }
            self { rotate := link(input: 3) }
            state idle initial { width := link(input: 4) }
            state active { other { height := link(input: 5) } }
          }
        }"#,
    );
    let definition = &result.definitions[0];
    let bindings: std::collections::BTreeMap<_, _> = definition.layers[0]
        .targets
        .iter()
        .chain(
            definition.layers[0]
                .states
                .iter()
                .flat_map(|state| &state.targets),
        )
        .flat_map(|target| {
            target.properties.iter().map(|property| {
                let PropertyValue::Binding { expression } = &property.value else {
                    panic!("inline controller must lower to a property binding");
                };
                let liva_compiler::expression::ExpressionKind::Reference { path } =
                    &expression.kind
                else {
                    panic!("inline controller must reference its generated declaration");
                };

                assert!(
                    definition
                        .let_bindings
                        .iter()
                        .any(|binding| binding.name == path[0].text)
                );

                (
                    path[0].text.as_str(),
                    (target.name.as_str(), property.name.as_str()),
                )
            })
        })
        .collect();

    assert_eq!(
        bindings,
        std::collections::BTreeMap::from([
            ("$controller_0_0_self_width", ("self", "width")),
            ("$controller_0_0_other_height", ("other", "height")),
            ("$controller_0_0_self_rotate", ("self", "rotate")),
            ("$controller_0_1_self_width", ("self", "width")),
            ("$controller_0_2_other_height", ("other", "height")),
        ])
    );
}

#[test]
fn controller_associations_do_not_leak_between_motions() {
    let source = "motion attached { let c = link(input: 1); layer base { width := c } } motion unbound { let c = link(input: 1); layer base {} }";
    let result = compile(source, true);

    assert_eq!(result.definitions.len(), 1);
    assert_eq!(result.definitions[0].name, "attached");
    assert_eq!(result.diagnostics.len(), 1);
    assert!(result.diagnostics[0].range.start > source.find("motion unbound").unwrap());
}

#[test]
fn malformed_duplicate_controller_declarations_keep_diagnostics_without_panicking() {
    for bindings in [
        "let c = link(input: 1); let c = 2",
        "let c = alias; let alias = link(input: 1); let c = alias.value",
        "let c = link(input: 1); let alias = c; let c = alias",
    ] {
        let result = compile(
            &format!("motion example {{ {bindings}; layer base {{ width := c }} }}"),
            true,
        );

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.duplicate")
        );
    }
}

#[test]
fn a_binding_does_not_satisfy_an_unrelated_controller_definition() {
    let source = "motion example { let bound = link(input: 1); let unbound = link(input: 2); let alias = unbound; layer base { width := bound } }";
    let diagnostic = single_controller_error(source);

    assert_eq!(
        &source[diagnostic.range.start..diagnostic.range.end],
        "link(input: 2)"
    );
}

#[test]
fn component_arguments_use_ordinary_string_expressions() {
    for (parameters, declarations, component, expected) in [
        (
            "",
            "",
            "\"z\"",
            serde_json::json!({"kind": "string", "value": "z"}),
        ),
        (
            "",
            "let axis = \"x\"",
            "axis",
            serde_json::json!({"kind": "reference", "path": ["axis"]}),
        ),
        (
            "axis: string",
            "let selected = axis",
            "(selected)",
            serde_json::json!({"kind": "reference", "path": ["selected"]}),
        ),
    ] {
        let source = format!(
            "motion example({parameters}) {{ {declarations}; let movement = link(input: 1, component: {component}); layer base {{ translate := movement }} }}"
        );
        let result = valid(&source);
        let movement = result.definitions[0]
            .let_bindings
            .iter()
            .find(|binding| binding.name == "movement")
            .unwrap();
        let liva_compiler::expression::ExpressionKind::Call { arguments, .. } =
            &movement.initializer.kind
        else {
            panic!("movement must be a link call");
        };
        let component = arguments
            .iter()
            .find(|argument| argument.name.text == "component")
            .unwrap();

        assert_eq!(serde_json::to_value(&component.value).unwrap(), expected);
    }
}
