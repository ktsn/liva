mod support;

use liva_compiler::ir::{Property, PropertyValue};
use serde_json::json;
use support::valid;

#[test]
fn declaration_sources_serialize_as_four_exclusive_variants() {
    let result = valid(
        r#"motion sample(distance: number) {
          let controller = link(input: distance)
          @tween(duration: 100)
          layer base {
            opacity: 1
            translate: ${distance}px 0
            width := controller
            scale ~> { 50%: .5; 100%: ${distance} }
          }
        }"#,
    );
    let properties = &result.definitions[0].layers[0].targets[0].properties;
    let expected = [
        json!({"kind": "literal", "value": "1"}),
        json!({"kind": "template", "parts": [{"kind": "reference", "path": ["distance"]}, "px 0"]}),
        json!({"kind": "binding", "expression": {"kind": "reference", "path": ["controller"]}}),
        json!({"kind": "keyframes", "frames": [
            {"offset": 0.5, "value": {"kind": "literal", "value": ".5"}},
            {"offset": 1.0, "value": {"kind": "template", "parts": [{"kind": "reference", "path": ["distance"]}]}}
        ]}),
    ];

    assert_eq!(properties.len(), expected.len());

    for (property, expected) in properties.iter().zip(expected) {
        let serialized = serde_json::to_value(&property.css().unwrap().value).unwrap();

        assert_eq!(serialized, expected);
        assert_eq!(
            serde_json::from_value::<PropertyValue>(serialized).unwrap(),
            property.css().unwrap().value
        );
    }
}

#[test]
fn declaration_sources_reject_overlapping_and_nested_payloads() {
    let reference = json!({"kind": "reference", "path": ["distance"]});

    for value in [
        json!({"kind": "literal", "value": "1", "parts": []}),
        json!({"kind": "template", "parts": [reference.clone()], "value": "${distance}"}),
        json!({"kind": "binding", "expression": reference.clone(), "value": "1"}),
        json!({"kind": "keyframes", "frames": [], "value": "1"}),
        json!({"kind": "keyframes", "frames": [{"offset": 1, "value": {"kind": "binding", "expression": reference}}]}),
        json!({"kind": "keyframes", "frames": [{"offset": 1, "value": {"kind": "keyframes", "frames": []}}]}),
        json!({"kind": "keyframes", "frames": [{"offset": 1, "value": {"kind": "literal", "value": "1"}, "template": []}]}),
    ] {
        assert!(serde_json::from_value::<PropertyValue>(value).is_err());
    }

    for sibling in ["template", "binding", "keyframes"] {
        let mut property = json!({"name": "scale", "value": {"kind": "literal", "value": "1"}});
        property[sibling] = json!([]);

        assert!(serde_json::from_value::<Property>(property).is_err());
    }
}
