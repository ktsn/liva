mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn event_blocks_flatten_transitions_in_source_order_with_typed_aliases() {
    let result = valid(
        r#"motion example {
      let pointer = drag(target: self)
      let release = pointer.release
      layer position {
        state closed initial {}
        state half {}
        state open {}
        on release {
          transition closed -> half when true
          transition half -> open
        }
        transition closed -> open when false
        on pointer.release { transition closed -> open when true }
      }
    }"#,
    );
    let transitions = &result.definitions[0].layers[0].transitions;

    assert_eq!(transitions.len(), 4);
    assert!(transitions[0].event.is_some());
    assert!(transitions[1].event.is_some());
    assert!(transitions[2].event.is_none());
    assert!(transitions[3].event.is_some());
}

#[test]
fn event_blocks_reject_invalid_input_scope_and_bodies() {
    for body in [
        "layer base { state idle initial {} on true { transition idle -> idle when true } }",
        "layer base { on pointer.release {} }",
        "on pointer.release { transition idle -> idle when true } layer base {}",
        "layer base { state idle initial {} on pointer.release { on pointer.release {} } }",
        "layer base { state idle initial {} on pointer.release { opacity: 1 } }",
        "layer base { state idle initial {} on pointer.release { let invalid = 1 } }",
    ] {
        let result = compile(
            &format!("motion example {{ let pointer = drag(target: self); {body} }}"),
            true,
        );

        assert!(result.definitions.is_empty(), "{body}");
        assert!(!result.diagnostics.is_empty(), "{body}");
    }
}
