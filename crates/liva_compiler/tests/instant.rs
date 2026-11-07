mod support;

use liva_compiler::{analysis, compile};
use support::valid;

#[test]
fn instant_is_a_typed_timing_value_at_every_timing_scope() {
    for body in [
        "@instant layer base { opacity: 1 }",
        "layer base { @instant body { opacity: 1 } }",
        "layer base { opacity: 1 @instant }",
        "layer base { @instant opacity ~> { 50%: .5; 100%: 1 } }",
        "layer base { state off initial {} @instant state on {} transition off -> on when true {} }",
        "layer base { opacity: 1; state off initial {} state on {} @instant transition off -> on when true { opacity ~> {} } }",
        "layer base {} @instant enter { opacity: 0 }",
        "layer base {} @instant leave { opacity: 0 }",
        "let immediate = instant; layer base { opacity: 1 @immediate }",
    ] {
        valid(&format!("motion example {{ {body} }}"));
    }

    assert!(
        analysis::hovers("motion example { layer base { opacity: 1 @instant } }")
            .iter()
            .any(|hover| hover.label == "instant: timing")
    );
}

#[test]
fn instant_keeps_existing_type_and_decorator_placement_rules() {
    for body in [
        "layer base { @tween() opacity ~> { 0%: 0 @instant; 100%: 1 } }",
        "layer base { opacity: 1 @tween(easing: instant) }",
        "layer base when instant {}",
        "layer base { opacity: ${instant} }",
        "@instant let value = 1; layer base {}",
        "layer base { opacity: 1 @instant() }",
    ] {
        let result = compile(&format!("motion example {{ {body} }}"), true);

        assert!(result.definitions.is_empty(), "{body}");
        assert!(!result.diagnostics.is_empty(), "{body}");
    }
}

#[test]
fn instant_is_shadowable_like_other_ordinary_builtins() {
    valid(
        "motion example { let instant = tween(duration: 200); layer base { opacity: 1 @instant } }",
    );

    let result = compile(
        "motion example(instant: number) { layer base { opacity: 1 @instant } }",
        true,
    );

    assert!(result.definitions.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.expression")
    );
}
