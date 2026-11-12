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

#[test]
fn misplaced_event_blocks_are_rejected_in_compiled_and_skipped_scopes() {
    for body in [
        "on pointer.release {} layer base {}",
        "unknown { on pointer.release {} } layer base {}",
        "state idle { on pointer.release {} } layer base {}",
        "transition { on pointer.release {} } layer base {}",
        "transition idle -> idle when true { on pointer.release {} } layer base {}",
        "layer base {} enter { on pointer.release {} }",
        "layer base {} leave { self { on pointer.release {} } }",
        "layer base { on pointer.release {} }",
        "layer base { state idle initial { on pointer.release {} } }",
        "layer base { self { on pointer.release {} } }",
        "layer base { self { unknown { on pointer.release {} } } }",
        "layer base { opacity ~> { on pointer.release {} } }",
        "layer base { state idle initial {} transition idle -> idle when true { on pointer.release {} } }",
        "layer base { state idle initial {} transition { on pointer.release {} } }",
    ] {
        let source = format!("motion example {{ let pointer = drag(target: self); {body} }}");
        let result = compile(&source, true);

        assert!(result.definitions.is_empty(), "{body}");
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.event")
            .unwrap_or_else(|| panic!("{body}: {:?}", result.diagnostics));

        assert_eq!(
            &source[diagnostic.range.start..diagnostic.range.end],
            "on pointer.release",
            "{body}"
        );
    }
}

#[test]
fn event_blocks_reject_decorators_and_nontransition_bodies() {
    for event in [
        "@tween() on pointer.release {}",
        "on pointer.release { self { opacity: 1 } }",
        "on pointer.release { state other {} }",
        "on pointer.release { on pointer.release {} }",
    ] {
        let source = format!(
            "motion example {{ let pointer = drag(target: self); layer base {{ state idle initial {{}} {event} }} }}"
        );
        let result = compile(&source, true);

        assert!(result.definitions.is_empty(), "{event}");
        assert!(
            result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "semantic.event"
                    && diagnostic.message
                        == "on blocks contain only layer transitions and accept no decorator"
            }),
            "{event}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn empty_event_blocks_validate_their_expression_without_transitions() {
    for event in ["true", "unknown", "1", "pointer.offset"] {
        let source = format!(
            "motion example {{ let pointer = drag(target: self); layer base {{ state idle initial {{}} on {event} {{}} }} }}"
        );
        let result = compile(&source, true);

        assert!(result.definitions.is_empty(), "{event}");
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.expression")
            .expect("Expected an invalid event expression");
        assert_eq!(&source[diagnostic.range.start..diagnostic.range.end], event);
    }
}

#[test]
fn empty_event_blocks_accept_typed_event_aliases() {
    valid(
        "motion example { let pointer = drag(target: self); let release = pointer.release; layer base { state idle initial {} on release {} } }",
    );
}

#[test]
fn targets_named_on_remain_valid_in_style_and_animation_scopes() {
    for body in [
        "layer base { on { opacity: 1 } }",
        "layer base { state idle initial { on { opacity: 1 } } }",
        "layer base { on { opacity: 1 } } @tween() enter { on { opacity: 0 } } @tween() leave { on { opacity: 0 } }",
        "layer base { on { opacity: 1 } state idle initial {} state open {} @tween() transition idle -> open when true { on { opacity: 0 } } }",
    ] {
        let result = valid(&format!("motion example {{ {body} }}"));

        assert!(
            result
                .mappings
                .as_ref()
                .is_some_and(|mappings| mappings.keys().any(|path| path.contains("/target/on"))),
            "{body}"
        );
    }
}
