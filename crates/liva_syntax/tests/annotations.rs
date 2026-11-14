use liva_syntax::ast::{AstNode, TypeAnnotation, TypeReference};
use liva_syntax::{Range, parse};

#[test]
fn annotations_decode_string_members_without_creating_runtime_expressions() {
    for (annotation, expected) in [
        (r#""x""#, vec!["x"]),
        (r#"'x' | "y" | 'x'"#, vec!["x", "y", "x"]),
        (r#"'${unresolved}'"#, vec!["${unresolved}"]),
        (
            r#"'' | '日本語😀' | ',)|{}'"#,
            vec!["", "日本語😀", ",)|{}"],
        ),
        (r#""a\"b" | 'a\'b' | "a\\b""#, vec!["a\"b", "a'b", "a\\b"]),
        (
            "/* before */ 'a' /* between */ | // line\n 'b' /* after */",
            vec!["a", "b"],
        ),
    ] {
        let source = format!("motion sample(value: {annotation}) {{ layer base {{}} }}");

        let parsed = parse(&source);
        let reference = parsed
            .root
            .syntax()
            .descendants()
            .find_map(TypeReference::cast)
            .unwrap();

        assert!(
            parsed.diagnostics.is_empty(),
            "{source}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(
            reference.annotation().unwrap(),
            TypeAnnotation::StringUnion(expected.into_iter().map(str::to_owned).collect())
        );
        assert!(
            !reference
                .syntax()
                .descendants()
                .any(|node| liva_syntax::ast::expression::Expr::cast(node).is_some())
        );
        assert_eq!(parsed.root.text(), source);
    }
}

#[test]
fn malformed_annotation_errors_identify_the_member_or_separator() {
    for annotation in [
        r#""x" |«»"#,
        r#"«|» "x""#,
        r#""x" «"y"»"#,
        r#""x" | «number»"#,
        r#"«string» | "x""#,
        r#"«"\q"»"#,
        r#""x" «||» "y""#,
    ] {
        let marked = format!("motion sample(value: {annotation}) {{ layer base {{}} }}");
        let start = marked.find('«').unwrap();
        let end = marked.find('»').unwrap() - '«'.len_utf8();
        let source = marked.replace(['«', '»'], "");

        let parsed = parse(&source);
        let error = parsed
            .diagnostics
            .iter()
            .find(|error| error.code == "syntax.type")
            .unwrap();

        assert_eq!(
            error.range,
            Range { start, end },
            "{marked}: {:?}",
            parsed.diagnostics
        );
    }
}

#[test]
fn every_annotation_prefix_preserves_source_and_valid_ranges() {
    let source =
        "// 😀\r\nmotion sample(value: '日本語,)|' /* 😀 */ | \"a\\\"b\" | '') { layer base {} }";

    for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
        let prefix = &source[..end];

        let parsed = parse(prefix);

        assert_eq!(parsed.root.text(), prefix);

        for diagnostic in parsed.diagnostics {
            assert!(diagnostic.range.start <= diagnostic.range.end);
            assert!(diagnostic.range.end <= end);
            assert!(prefix.is_char_boundary(diagnostic.range.start));
            assert!(prefix.is_char_boundary(diagnostic.range.end));
        }

        for reference in parsed
            .root
            .syntax()
            .descendants()
            .filter_map(TypeReference::cast)
        {
            let _ = reference.annotation();
        }
    }
}
