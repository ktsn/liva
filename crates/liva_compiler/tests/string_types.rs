mod support;

use liva_compiler::{analysis::hovers, expression::Type};
use std::borrow::Cow;
use support::valid;

fn literal(value: &str) -> Type {
    Type::StringLiteral(value.to_owned().into())
}

fn union(values: &[&str]) -> Type {
    Type::StringUnion(Cow::Owned(
        values
            .iter()
            .map(|value| (*value).to_owned().into())
            .collect(),
    ))
}

#[test]
fn string_assignability_compares_sets_of_decoded_values() {
    let cases = [
        (literal("x"), literal("x"), true),
        (literal("x"), literal("y"), false),
        (literal("x"), union(&["y", "x"]), true),
        (literal("z"), union(&["y", "x"]), false),
        (union(&["x"]), literal("x"), true),
        (union(&["x", "y"]), literal("x"), false),
        (union(&["x"]), union(&["x", "y"]), true),
        (union(&["x", "y"]), union(&["x"]), false),
        (union(&["x", "y", "x"]), union(&["y", "x"]), true),
        (union(&["x", "y"]), union(&["y", "x", "y"]), true),
        (union(&["x"]), union(&["z"]), false),
        (literal(""), union(&["", "日本語", "\"\\\n"]), true),
        (
            union(&["日本語", "\"\\\n"]),
            union(&["", "\"\\\n", "日本語"]),
            true,
        ),
        (literal("x"), Type::String, true),
        (union(&["x", "y"]), Type::String, true),
        (Type::String, literal("x"), false),
        (Type::String, union(&["x", "y"]), false),
        (Type::String, Type::String, true),
        (Type::Number, literal("1"), false),
        (literal("true"), Type::Boolean, false),
    ];

    for (source, destination, expected) in cases {
        assert_eq!(
            source.is_assignable_to(&destination),
            expected,
            "{source} -> {destination}"
        );
    }
}

#[test]
fn type_display_quotes_literals_and_normalizes_unions() {
    assert_eq!(
        literal("\"\\\n\r\t日本語").to_string(),
        r#""\"\\\n\r\t日本語""#
    );
    assert_eq!(literal("").to_string(), "\"\"");
    assert_eq!(union(&["y", "x", "y"]).to_string(), "\"x\" | \"y\"");
}

#[test]
fn inference_preserves_decoded_literals_through_forward_aliases_and_parentheses() {
    let source = r#"motion sample {
        let alias = (later)
        let later = ('日本語\n\'')
        layer base { content: ${alias} }
    }"#;

    let compiled = valid(source);
    let found = hovers(source);

    assert_eq!(compiled.definitions[0].let_bindings.len(), 2);

    for name in ["alias", "later"] {
        assert!(
            found
                .iter()
                .any(|hover| hover.label == format!("{name}: \"日本語\\n'\"")),
            "{found:?}"
        );
    }
}

#[test]
fn strings_keep_comparison_and_interpolation_behavior_without_arithmetic() {
    for condition in [
        "'x' == 'y'",
        "'x' != label",
        "label < 'y'",
        "'x' <= 'y'",
        "'y' > 'x'",
        "label >= ''",
    ] {
        valid(&format!(
            "motion sample(label: string) {{ let value = 'x'; layer base {{ content: ${{value}} }} layer selected when {condition} {{}} }}"
        ));
    }

    for expression in [
        "'x' + 'y'",
        "'x' - 'y'",
        "'x' && 'y'",
        "'x' == 1",
        "'x' == true",
    ] {
        let source = format!("motion sample {{ let value = {expression}; layer base {{}} }}");

        let result = liva_compiler::compile(&source, false);

        assert!(result.definitions.is_empty(), "{source}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.message == "Incompatible expression operands")
        );
    }
}
