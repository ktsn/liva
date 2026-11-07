mod support;

use liva_compiler::{builtins, compile};
use support::valid;

#[test]
fn motion_values_can_shadow_every_ordinary_builtin() {
    for (name, _, reserved) in builtins::symbols() {
        if reserved {
            continue;
        }

        let result = valid(&format!(
            "motion example {{ let {name} = 1; layer base {{ opacity: ${{{name}}} }} }}"
        ));

        assert_eq!(result.definitions[0].let_bindings[0].name, name);
    }
}

#[test]
fn forward_shadowing_resolves_the_motion_binding_before_the_parent_constant() {
    let source = "motion example { let result = easeOut + 1; let easeOut = 2; layer base { opacity: ${result} } }";
    let result = valid(source);
    let labels = liva_compiler::analysis::hovers(source);

    assert_eq!(result.definitions[0].let_bindings.len(), 2);
    assert!(labels.iter().any(|hover| hover.label == "result: number"));
    assert!(
        labels
            .iter()
            .filter(|hover| hover.label.starts_with("easeOut:"))
            .all(|hover| hover.label == "easeOut: number")
    );
}

#[test]
fn shadowed_functions_are_not_called_through_the_parent_environment() {
    for source in [
        "motion example(tween: number) { @tween()\nlayer base {} }",
        "motion example { let tween = 1; let result = tween(); layer base {} }",
        "motion example { let result = tween(); let tween = 1; layer base {} }",
        "motion example { layer base { tween { opacity: 1 } } @tween()\nenter { opacity: 0 } }",
        "motion example { let drag = 1; let result = drag(target: self); layer base {} }",
    ] {
        let result = compile(source, true);
        let error = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.starts_with("Value is not callable:"));

        assert!(result.definitions.is_empty(), "{source}");
        assert!(error.is_some(), "{source}: {:?}", result.diagnostics);
    }
}

#[test]
fn function_symbols_are_not_first_class_values() {
    let result = compile("motion example { let value = tween; layer base {} }", true);

    assert!(result.definitions.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message == "Functions cannot be used as values")
    );
}

#[test]
fn function_name_dependencies_detect_local_cycles() {
    for bindings in [
        "let tween = tween()",
        "let tween = result; let result = tween()",
    ] {
        let result = compile(
            &format!("motion example {{ {bindings}; layer base {{}} }}"),
            true,
        );

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("Cyclic let binding dependency")),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn target_reuse_across_layers_and_states_refers_to_one_motion_symbol() {
    valid(
        "motion example { let ui = interaction(target: body); layer base { body { opacity: 1 } state off initial { body { scale: 1 } } state on { body { scale: 1.2 } } transition off -> on when ui.hover {} } layer hover when ui.hover { body { opacity: .5 } } }",
    );
}

#[test]
fn shadows_are_local_to_the_motion_that_declares_them() {
    valid(
        "motion first { let interaction = 1; layer base { opacity: ${interaction} } } motion second { let ui = interaction(target: self); layer base {} layer hover when ui.hover { opacity: .5 } }",
    );
}

#[test]
fn invalid_self_declarations_are_still_rejected() {
    for source in [
        "motion example(self: unknown) { layer base {} }",
        "motion example { let self = ; layer base {} }",
    ] {
        let result = compile(source, true);

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message == "self is a reserved built-in target"),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn an_invalid_let_initializer_does_not_allow_redeclaration() {
    let result = compile(
        "motion example { let tween = ; let tween = 2; layer base {} }",
        true,
    );

    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message == "Duplicate variable: tween")
    );
}
