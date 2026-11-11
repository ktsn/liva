use liva_compiler::ir::PropertyValue;
#[path = "support/declarations.rs"]
mod declarations;
mod support;

use declarations::{assert_error, assert_recovers, motion};
use liva_compiler::compile;
use serde_json::json;
use support::valid;

#[test]
fn event_conditions_lower_to_boolean_expression_ir_in_source_order() {
    let result = valid(&motion(
        "event changed when ready && amount > 120
         let ready = enabled
         event labelled when label == 'ready'
         event initial when true",
    ));
    let events = &result.definitions[0].events;

    assert_eq!(
        events
            .iter()
            .map(|event| event.name.as_str())
            .collect::<Vec<_>>(),
        ["changed", "labelled", "initial"]
    );
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        json!({
            "name": "changed",
            "when": {
                "kind": "binary", "operator": "&&",
                "left": { "kind": "reference", "path": ["ready"] },
                "right": {
                    "kind": "binary", "operator": ">",
                    "left": { "kind": "reference", "path": ["amount"] },
                    "right": { "kind": "number", "value": 120.0 }
                }
            }
        })
    );
    assert_eq!(
        serde_json::to_value(&events[2].when).unwrap(),
        json!({"kind": "boolean", "value": true})
    );
    assert_eq!(result.definitions[0].layers.len(), 1);
}

#[test]
fn event_names_use_motion_local_event_namespace() {
    for name in [
        "dismiss",
        "dismiss-item",
        "_dismiss",
        "Dismiss2",
        "enabled",
        "body",
        "idle",
    ] {
        let result = valid(&motion(&format!("event {name} when enabled")));
        assert_eq!(result.definitions[0].events[0].name, name);
    }

    let source = format!(
        "{}\nmotion other {{ event dismiss when true; layer idle {{}} }}",
        motion("event dismiss when enabled")
    );
    let result = valid(&source);
    assert_eq!(result.definitions.len(), 2);
    assert_eq!(
        result.definitions[0].events[0].name,
        result.definitions[1].events[0].name
    );

    let duplicate = assert_error(
        "event dismiss when true; event «dismiss» when false",
        "semantic.duplicate",
    );
    assert_eq!(duplicate.related.len(), 1);
    let source = motion("event dismiss when true; event dismiss when false");
    assert_eq!(
        &source[duplicate.related[0].start..duplicate.related[0].end],
        "dismiss"
    );
}

#[test]
fn event_names_and_conditions_reject_invalid_types_and_references_at_their_ranges() {
    for name in ["1dismiss", "dismiss.item", "two names", "日本語"] {
        assert_error(&format!("event «{name}» when true"), "semantic.event");
    }

    for condition in [
        "«123»",
        "«'text'»",
        "«body»",
        "«missing»",
        "movement.«missing»",
        "«movement.offset»",
        "enabled && «1»",
    ] {
        assert_error(
            &format!("let movement = drag(target: body); event dismiss when {condition}"),
            "semantic.expression",
        );
    }

    let source = format!(
        "{}\nmotion other {{ event dismiss when enabled; layer idle {{}} }}",
        motion("")
    );
    let result = compile(&source, false);
    assert_eq!(result.definitions.len(), 1);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("Unknown variable"))
    );
}

#[test]
fn drag_release_conditions_and_shared_layer_styles_compile_together() {
    let result = valid(include_str!("../../../fixtures/presence.liv"));
    let definition = &result.definitions[0];

    assert_eq!(definition.events[0].name, "dismiss");
    let json = serde_json::to_value(&definition.events[0].when).unwrap();
    assert_eq!(
        json["left"],
        json!({"kind": "reference", "path": ["movement", "released"]})
    );
    assert_eq!(
        json["right"]["left"],
        json!({"kind": "reference", "path": ["movement", "offset", "x"]})
    );
    assert_eq!(
        definition.layers[0].targets[0]
            .properties
            .iter()
            .find(|property| property.name == "opacity")
            .map(|property| &property.value),
        Some(&PropertyValue::Literal { value: "1".into() })
    );
    assert_eq!(
        definition.layers[0].targets[1]
            .properties
            .iter()
            .find(|property| property.name == "opacity")
            .map(|property| &property.value),
        Some(&PropertyValue::Literal { value: "1".into() })
    );
}

#[test]
fn malformed_events_do_not_suppress_later_valid_motions() {
    for body in [
        "event",
        "event dismiss",
        "event dismiss when",
        "event dismiss when !",
    ] {
        assert_recovers(body);
    }
}
