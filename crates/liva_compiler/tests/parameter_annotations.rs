mod support;

use liva_compiler::{analysis::hovers, compile};
use serde_json::json;
use support::valid;

#[test]
fn literal_annotations_emit_exact_normalized_candidate_sets() {
    for (annotation, mut expected) in [
        (r#""x""#, vec!["x"]),
        (r#"'y' | "x" | 'y'"#, vec!["x", "y"]),
        (
            r#"'' | '日本語😀' | ',)|{}'"#,
            vec!["", "日本語😀", ",)|{}"],
        ),
        (r#""a\"b" | 'a\'b' | "a\\b""#, vec!["a\"b", "a'b", "a\\b"]),
        (
            "/* before */ 'a' /* between */ | // line\n 'b' /* after */",
            vec!["a", "b"],
        ),
        (r#"" x " | "X" | "x""#, vec![" x ", "X", "x"]),
    ] {
        let source = format!(
            "motion sample(value: {annotation}) {{ let copy = (value); layer base {{ content: ${{copy}} }} }}"
        );
        expected.sort_unstable();

        let result = valid(&source);
        let parameter = serde_json::to_value(&result.definitions[0].parameters[0]).unwrap();

        assert_eq!(
            parameter,
            json!({"name": "value", "type": {"kind": "stringUnion", "values": expected}})
        );
    }
}

#[test]
fn declared_types_survive_forward_aliases_and_use_string_assignability() {
    let source = r#"motion sample(position: "start" | 'end', axis: 'x') {
        let selected = (later)
        let later = position
        let fixed = axis
        let curve = steps(count: 4, position: selected)
        layer base { content: ${fixed} }
        layer active when selected > "" {}
    }"#;

    valid(source);
    let found = hovers(source);

    for label in [
        "position: \"end\" | \"start\"",
        "selected: \"end\" | \"start\"",
        "later: \"end\" | \"start\"",
        "axis: \"x\"",
        "fixed: \"x\"",
    ] {
        assert!(
            found.iter().any(|hover| hover.label == label),
            "{label}: {found:?}"
        );
    }
}

#[test]
fn annotated_string_sets_do_not_satisfy_numeric_arguments() {
    let source = r#"motion sample(value: "start" | "end") { let timing = tween(duration: value); layer base {} }"#;

    let result = compile(source, false);
    let error = result
        .diagnostics
        .iter()
        .find(|error| {
            error
                .message
                .starts_with("Invalid argument type for tween.duration")
        })
        .unwrap();

    assert!(result.definitions.is_empty());
    assert_eq!(&source[error.range.start..error.range.end], "value");
    assert!(
        error
            .message
            .contains("expected number, got \"end\" | \"start\"")
    );
}

#[test]
fn malformed_union_recovery_keeps_later_motions_and_precise_ranges() {
    for annotation in [
        r#""x" |"#,
        r#""x" "y""#,
        r#"number | "x""#,
        r#""x" | string"#,
        r#""\q""#,
    ] {
        let source = format!(
            "motion bad(value: {annotation}) {{ layer base {{}} }} motion good {{ layer base {{}} }}"
        );

        let result = compile(&source, false);

        assert_eq!(
            result
                .definitions
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            ["good"],
            "{source}: {:?}",
            result.diagnostics
        );
        assert!(
            result
                .diagnostics
                .iter()
                .any(|error| error.code == "syntax.type")
        );

        for diagnostic in result.diagnostics {
            assert!(diagnostic.range.start <= diagnostic.range.end);
            assert!(diagnostic.range.end <= source.len());
            assert!(source.is_char_boundary(diagnostic.range.start));
            assert!(source.is_char_boundary(diagnostic.range.end));
        }
    }
}

#[test]
fn incomplete_annotations_keep_compiler_diagnostics_within_source_boundaries() {
    let source = "// 日本語😀\r\nmotion sample(value: '😀,)|' /* comment */ | \"a\\\"b\" | '') { layer base { content: ${value} } }";

    for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
        let prefix = &source[..end];

        let result = compile(prefix, true);

        for diagnostic in result.diagnostics {
            assert!(
                diagnostic.range.start <= diagnostic.range.end,
                "{prefix}: {diagnostic:?}"
            );
            assert!(
                diagnostic.range.end <= prefix.len(),
                "{prefix}: {diagnostic:?}"
            );
            assert!(prefix.is_char_boundary(diagnostic.range.start));
            assert!(prefix.is_char_boundary(diagnostic.range.end));
        }
    }
}
