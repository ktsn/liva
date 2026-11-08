mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn timeout_is_a_boolean_call_using_ordinary_expressions_and_aliases() {
    valid(
        r#"motion feedback(status: string, duration: number) {
          let expired = timeout(when: status == "success" || status == "error", duration: duration)
          let alias = expired
          layer request {
            state visible initial { opacity: 1 }
            state idle { opacity: 0 }
            transition visible -> idle when alias
          }
        }"#,
    );
}

#[test]
fn timeout_requires_a_condition_and_numeric_duration() {
    for call in [
        "timeout()",
        "timeout(when: true)",
        "timeout(when: 1, duration: 100)",
        "timeout(when: true, duration: false)",
        "timeout(when: true, duration: 100, reset: true)",
    ] {
        let result = compile(
            &format!("motion feedback {{ let expired = {call}; layer base {{ opacity: 1 }} }}"),
            true,
        );

        assert!(result.definitions.is_empty(), "{call}");
        assert!(!result.diagnostics.is_empty(), "{call}");
    }
}
