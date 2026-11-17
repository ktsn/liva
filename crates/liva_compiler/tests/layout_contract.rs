use liva_compiler::ir::{LayoutAxes, LayoutDeclaration};
use serde_json::json;

#[test]
fn layout_declaration_round_trip_preserves_physical_axes_and_timing() {
    let value = json!({
        "kind": "layout", "name": "$layout",
        "axes": { "x": false, "y": true, "width": false, "height": true },
        "timingExpression": { "kind": "reference", "path": ["timing"] }
    });

    let declaration: LayoutDeclaration = serde_json::from_value(value.clone()).unwrap();

    assert_eq!(serde_json::to_value(declaration).unwrap(), value);
}

#[test]
fn layout_axes_reject_missing_non_boolean_and_unknown_fields() {
    for value in [
        json!({ "x": true, "y": false, "width": true }),
        json!({ "x": 1, "y": false, "width": true, "height": false }),
        json!({ "x": true, "y": false, "width": true, "height": false, "anchor": "center" }),
    ] {
        assert!(serde_json::from_value::<LayoutAxes>(value).is_err());
    }
}

#[test]
fn layout_declaration_rejects_css_selection_sources_and_other_names() {
    let valid = json!({
        "kind": "layout", "name": "$layout",
        "axes": { "x": false, "y": false, "width": false, "height": false }
    });

    for (field, value) in [
        ("name", json!("transform")),
        ("kind", json!("css")),
        ("value", json!({ "kind": "literal", "value": "position" })),
        ("keyframes", json!([])),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;

        assert!(serde_json::from_value::<LayoutDeclaration>(invalid).is_err());
    }
}
