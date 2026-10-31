use liva_syntax::{Kind, parse, semantic_text};

#[test]
fn lossless_prefixes_and_safe_ast() {
    let fixtures = [
        include_str!("../../../fixtures/toggle.liv"),
        "日本語 {\r\n x: '\"😀' /* } */; y: var(--a, [a,b])\r\n}",
        "motion a { timing: unknown(a: fn([1, 2], '),'), b: 1,) }",
        "motion a { timing: x(a: \"unfinished",
        "motion a { /* unterminated",
    ];

    for source in fixtures {
        for end in (0..=source.len()).filter(|i| source.is_char_boundary(*i)) {
            let input = &source[..end];
            let parsed = parse(input);
            assert_eq!(parsed.root.text(), input);
            assert!(parsed.diagnostics.len() <= input.len() + 1);

            for error in parsed.diagnostics {
                assert!(error.range.start <= error.range.end && error.range.end <= input.len());
                assert!(input.is_char_boundary(error.range.start));
                assert!(input.is_char_boundary(error.range.end));
            }

            for block in parsed.root.children(Kind::Block) {
                let _ = (block.header(), block.value());
            }
        }
    }
}

#[test]
fn generic_calls_and_boundaries() {
    for args in [
        "",
        "duration: 350ms",
        "duration: 350ms,",
        "duration: 350ms, easing: cubic-bezier(.2, .8, .2, 1)",
        "\r\n easing: fn([1,2], '),'),\r\n duration: 350ms,\r\n",
    ] {
        let source = format!("motion toggle {{ transition {{ timing: unknown({args}) }} }}");
        let parsed = parse(&source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{args}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.root.text(), source);
    }

    for args in [
        ", duration: 1ms",
        "duration: 1ms,,",
        "duration: 1ms,, easing: linear",
        "duration: fn([1,2)",
    ] {
        let source = format!("motion a {{ timing: tween({args}) }}");
        assert!(!parse(&source).diagnostics.is_empty(), "{args}");
    }

    assert!(
        parse(include_str!("../../../fixtures/toggle.liv"))
            .diagnostics
            .is_empty()
    );
}

#[test]
fn comments_and_strings_keep_opaque_values() {
    assert_eq!(
        semantic_text(" /* a */ var(--a, '/*x*/') // end"),
        "var(--a, '/*x*/')"
    );
    assert_eq!(semantic_text("https://example.com"), "https://example.com");
}

#[test]
fn recovery_retains_later_blocks() {
    let parsed = parse("broken\nmotion valid { state on { target { color: red } } }");
    assert!(!parsed.diagnostics.is_empty());
    assert_eq!(
        parsed
            .root
            .children(Kind::Block)
            .next()
            .unwrap()
            .header()
            .as_deref(),
        Some("motion valid")
    );
}

#[test]
fn names_are_ascii_and_case_sensitive() {
    for name in ["Toggle", "toggle_2", "_toggle", "toggle-name"] {
        assert!(
            parse(&format!(
                "motion {name} {{ state On {{ thumb {{ --offset: 2px }} }} }}"
            ))
            .diagnostics
            .is_empty()
        );
    }

    for name in ["日本語", "--toggle", "1toggle", "a.b"] {
        assert!(!parse(&format!("motion {name} {{}}")).diagnostics.is_empty());
        assert!(
            !parse(&format!("motion toggle {{ state {name} {{}} }}"))
                .diagnostics
                .is_empty()
        );
        assert!(
            !parse(&format!("motion toggle {{ state on {{ {name} {{}} }} }}"))
                .diagnostics
                .is_empty()
        );
    }
}

#[test]
fn context_comments_escapes_and_group_recovery() {
    let source = "motion a { state on { target { timing: var(--x, 1); content: \\); --x: \\, } } transition { timing /* note */: tween(duration: 1ms) } }";
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(
        parsed
            .root
            .0
            .descendants()
            .filter(|n| n.kind() == Kind::Call)
            .count(),
        1
    );

    let parsed =
        parse("motion a { state on { t { x: fn(1 } } } motion b { state on { t { x: 1 } } }");
    assert!(!parsed.diagnostics.is_empty());
    assert_eq!(parsed.root.children(Kind::Block).count(), 2);
}

#[test]
fn comment_terminators_do_not_overlap_openers() {
    for source in ["/*/", "/*"] {
        assert!(!parse(source).diagnostics.is_empty());
        assert_eq!(parse(source).root.text(), source);
    }

    assert!(parse("/**/").diagnostics.is_empty());
}

#[test]
fn token_boundary_comments_and_state_whitespace() {
    for gap in [" ", "\t", " /* comment */ "] {
        let source = format!("motion a {{ state{gap}on {{ t {{ timing: var(--x, 1) }} }} }}");
        assert!(parse(&source).diagnostics.is_empty(), "{source}");
    }

    assert_eq!(semantic_text("/* first */// second"), "");
    assert_eq!(semantic_text("[]// second"), "[]");
    assert_eq!(semantic_text("'x'// second"), "'x'");
    let parsed =
        parse("motion a { state on { t { color:// comment\nred: https://example.com } } }");
    assert!(parsed.diagnostics.is_empty());
    let values: Vec<_> = parsed
        .root
        .0
        .descendants()
        .filter(|n| n.kind() == Kind::Value)
        .map(|n| semantic_text(&n.text().to_string()))
        .collect();
    assert_eq!(values, ["", "https://example.com"]);
}

#[test]
fn urls_are_opaque_after_other_raw_tokens() {
    assert_eq!(
        semantic_text("prefix https://example.com"),
        "prefix https://example.com"
    );
    let parsed = parse("motion a { state on { t { custom: prefix https://example.com } } }");
    let value = parsed
        .root
        .0
        .descendants()
        .find(|n| n.kind() == Kind::Value)
        .unwrap();
    assert_eq!(
        semantic_text(&value.text().to_string()),
        "prefix https://example.com"
    );
}

#[test]
fn reactive_syntax_is_lossless_even_when_truncated() {
    for source in [
        include_str!("../../../fixtures/card.liv"),
        include_str!("../../../fixtures/reactive-toggle.liv"),
    ] {
        assert!(
            parse(source).diagnostics.is_empty(),
            "{:?}",
            parse(source).diagnostics
        );

        for end in 0..=source.len() {
            let parsed = parse(&source[..end]);
            assert_eq!(parsed.root.text(), &source[..end]);
            assert!(
                parsed
                    .diagnostics
                    .iter()
                    .all(|d| d.range.start <= d.range.end && d.range.end <= end)
            );
        }
    }

    let source = "motion a { state idle { t { translate: ${broken\nscale: 1\n} } }";
    let parsed = parse(source);
    assert_eq!(parsed.root.text(), source);
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|d| d.code == "syntax.interpolation")
    );
    assert!(parsed.root.text().contains("scale: 1"));
}

#[test]
fn parameter_types_have_lossless_nodes_and_recover_at_the_body() {
    let source = "motion progress( /* 😀 */ value: number,\r\n enabled: boolean, label: string) { state idle {} }";
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let motion = parsed.root.child(Kind::Block).unwrap();
    assert_eq!(motion.motion_name().as_deref(), Some("progress"));
    assert_eq!(motion.parameters().count(), 3);
    assert_eq!(
        parsed
            .root
            .0
            .descendants()
            .filter(|node| node.kind() == Kind::TypeReference)
            .count(),
        3
    );
    assert_eq!(
        parsed
            .root
            .0
            .descendants()
            .filter(|node| node.kind() == Kind::Call)
            .count(),
        0
    );

    for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
        let parsed = parse(&source[..end]);
        assert_eq!(parsed.root.text(), &source[..end]);
        assert!(
            parsed
                .diagnostics
                .iter()
                .all(|d| d.range.start <= d.range.end && d.range.end <= end)
        );
    }

    for header in [
        "motion broken(value:",
        "motion broken(value",
        "motion broken(,)",
    ] {
        let source = format!("{header} {{ state idle {{}} }} motion valid {{ state idle {{}} }}");
        let parsed = parse(&source);
        assert_eq!(parsed.root.text(), source);
        assert!(!parsed.diagnostics.is_empty());
        assert_eq!(
            parsed
                .root
                .children(Kind::Block)
                .last()
                .unwrap()
                .motion_name()
                .as_deref(),
            Some("valid")
        );
    }
}
