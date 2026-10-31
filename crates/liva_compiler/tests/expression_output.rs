use liva_compiler::expression::parse;
use serde_json::json;

#[test]
fn located_ast_lowers_to_the_runtime_expression_format() {
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
