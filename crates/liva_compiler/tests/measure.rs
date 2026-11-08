mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn measure_exposes_typed_bounds_using_targets_and_aliases() {
    valid(
        r#"motion tabs {
      let target = label
      let bounds = measure(target: target, relativeTo: self)
      layer base {
        label {}
        indicator { translate: ${bounds.x}px ${bounds.y}px; width: ${bounds.width}px; height: ${bounds.height}px }
      }
      layer attached when bounds.attached { opacity: 1 }
    }"#,
    );

    valid(
        "motion example { let bounds = measure(target: self); layer base { width: ${bounds.width}px } }",
    );
}

#[test]
fn measure_rejects_non_targets_unknown_members_and_non_boolean_conditions() {
    for body in [
        "let bounds = measure()",
        "let bounds = measure(target: 1)",
        "let bounds = measure(target: self, relativeTo: false)",
        "let bounds = measure(target: self); let invalid = bounds.left",
        "let bounds = measure(target: self); layer invalid when bounds.width {}",
    ] {
        let result = compile(
            &format!("motion example {{ {body}; layer base {{ opacity: 1 }} }}"),
            true,
        );

        assert!(result.definitions.is_empty(), "{body}");
        assert!(!result.diagnostics.is_empty(), "{body}");
    }
}
