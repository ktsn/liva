use liva_compiler::ir::PropertyValue;
mod support;
use liva_compiler::compile;
use liva_compiler::expression::parse;
use serde_json::json;
use support::valid;

#[test]
fn syntax_view_lowers_to_the_runtime_expression_format() {
    let expression =
        parse("custom(amount: -(movement.offset.x + 2), enabled: !false, label: '日本')").unwrap();
    let output = serde_json::to_value(expression).unwrap();

    assert_eq!(
        output,
        json!({
            "kind": "call",
            "function": "custom",
            "arguments": [
                {
                    "name": "amount",
                    "value": {
                        "kind": "unary",
                        "operator": "-",
                        "operand": {
                            "kind": "binary",
                            "operator": "+",
                            "left": { "kind": "reference", "path": ["movement", "offset", "x"] },
                            "right": { "kind": "number", "value": 2.0 }
                        }
                    }
                },
                {
                    "name": "enabled",
                    "value": {
                        "kind": "unary",
                        "operator": "!",
                        "operand": { "kind": "boolean", "value": false }
                    }
                },
                { "name": "label", "value": { "kind": "string", "value": "日本" } }
            ]
        })
    );
}

#[test]
fn css_template_json_preserves_quotes_comments_and_text_segments() {
    for (value, expected) in [
        (
            "'hello ${label}!'",
            json!(["'hello ", {"kind": "reference", "path": ["label"]}, "!'"]),
        ),
        (
            "${label} /* comment */ ${label}",
            json!([{"kind": "reference", "path": ["label"]}, "   ", {"kind": "reference", "path": ["label"]}]),
        ),
    ] {
        let source = format!(
            "motion demo(label: string) {{ layer idle {{ body {{ content: {value} }} }} }}"
        );
        let compiled = liva_compiler::compile(&source, false);

        assert!(
            compiled.diagnostics.is_empty(),
            "{:?}",
            compiled.diagnostics
        );
        let property = &compiled.definitions[0].layers[0].targets[0].properties[0];
        assert_eq!(
            serde_json::to_value(&property.value).unwrap(),
            json!({"kind": "template", "parts": expected})
        );
    }
}

#[test]
fn call_initializers_serialize_named_arguments() {
    let result = valid(
        "motion card { let movement=drag(\n target: card_body,\n)\n layer idle { card_body { translate: ${movement.offset.x}px 0 } } }",
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
}

#[test]
fn hyphenated_bindings_compile_to_reference_and_binary_ir() {
    let source = r#"motion demo(max-value: number) {
  let adjusted-value = max-value - 1
  let pointer-state = drag(target: main-body)
  layer idle { main-body { opacity: ${adjusted-value} } }
  layer active when pointer-state.active { main-body { opacity: ${max-value} } }
}"#;
    let result = compile(source, false);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let definition = &result.definitions[0];
    assert_eq!(
        serde_json::to_value(&definition.let_bindings[0].initializer).unwrap(),
        json!({
            "kind": "binary", "operator": "-",
            "left": { "kind": "reference", "path": ["max-value"] },
            "right": { "kind": "number", "value": 1.0 }
        })
    );
    assert_eq!(
        serde_json::to_value(parse("max-min").unwrap()).unwrap(),
        json!({"kind": "reference", "path": ["max-min"]})
    );
}

#[test]
fn css_units_urls_and_escapes_keep_their_output_spelling() {
    let source = r#"motion demo(label: string) {
  let newline = "\n"
  layer idle {
    body {
      width: calc(100% - 20px);
      background-image: url("https://example.com/a.png");
      content: "\41 ${label /* 😀 */} \n";
      --escape: \);
    }
  }
}"#;
    let result = compile(source, false);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let definition = &result.definitions[0];
    assert_eq!(
        serde_json::to_value(&definition.let_bindings[0].initializer).unwrap(),
        json!({"kind": "string", "value": "\n"})
    );
    let properties = &definition.layers[0].targets[0].properties;
    assert_eq!(
        properties[0].value,
        PropertyValue::Literal {
            value: "calc(100% - 20px)".into()
        }
    );
    assert_eq!(
        properties[1].value,
        PropertyValue::Literal {
            value: r#"url("https://example.com/a.png")"#.into()
        }
    );
    assert_eq!(
        serde_json::to_value(&properties[2].value).unwrap()["parts"],
        json!([
            "\"\\41 ", {"kind": "reference", "path": ["label"]}, " \\n\""
        ])
    );
    assert_eq!(
        properties[3].value,
        PropertyValue::Literal {
            value: r"\)".into()
        }
    );
}

#[test]
fn quoted_templates_preserve_nested_quotes_and_escapes() {
    for template in [
        r#""${'😀}'}""#,
        r#""\${label}""#,
        r#""${label // comment}""#,
    ] {
        let source = format!(
            "motion a(label: string) {{ layer idle {{ body {{ content: {template} }} }} }}"
        );
        let result = compile(&source, true);
        assert!(
            result.diagnostics.is_empty(),
            "{template}: {:?}",
            result.diagnostics
        );
        let range =
            &result.mappings.as_ref().unwrap()["a/layer/idle/target/body/property/content/value"]
                .range;
        assert_eq!(source[range.start..range.end].trim(), template);
        assert!(matches!(
            result.definitions[0].layers[0].targets[0].properties[0].value,
            PropertyValue::Template { .. }
        ));
    }
}

#[test]
fn expression_strings_decode_escapes_without_interpreting_interpolation() {
    for (source, expected) in [
        (r#""${unknown}""#, "${unknown}"),
        (r#""${value // comment}""#, "${value // comment}"),
        (r#""say \"hello\"""#, "say \"hello\""),
    ] {
        assert_eq!(
            serde_json::to_value(parse(source).unwrap()).unwrap(),
            json!({"kind": "string", "value": expected})
        );
    }
}
