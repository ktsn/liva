use liva_syntax::ast::{AstNode, HasItems, HasValue};
use liva_syntax::{parse, semantic_text};

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
}

#[test]
fn block_names_follow_identifier_rules() {
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
fn comment_terminators_do_not_overlap_openers() {
    for source in ["/*/", "/*"] {
        assert!(!parse(source).diagnostics.is_empty());
        assert_eq!(parse(source).root.text(), source);
    }

    assert!(parse("/**/").diagnostics.is_empty());
}

#[test]
fn semantic_text_removes_comments_and_preserves_quoted_css() {
    for (source, expected) in [
        (" /* a */ var(--a, '/*x*/') // end", "var(--a, '/*x*/')"),
        ("/* first */// second", ""),
        ("[]// second", "[]"),
        ("'x'// second", "'x'"),
        (
            "prefix \"https://example.com\"",
            "prefix \"https://example.com\"",
        ),
    ] {
        assert_eq!(semantic_text(source), expected, "{source}");
    }
}

#[test]
fn comments_separate_headers_and_leave_following_declarations() {
    for gap in [" ", "\t", " /* comment */ "] {
        let source = format!("motion a {{ state{gap}on {{ t {{ timing: var(--x, 1) }} }} }}");
        assert!(parse(&source).diagnostics.is_empty(), "{source}");
    }

    let parsed =
        parse("motion a { state on { t { color:// comment\nred: \"https://example.com\" } } }");
    assert!(parsed.diagnostics.is_empty());
    let target = parsed
        .root
        .motions()
        .next()
        .unwrap()
        .states()
        .next()
        .unwrap()
        .targets()
        .next()
        .unwrap();
    let values: Vec<_> = target
        .properties()
        .map(|property| property.value_text().unwrap())
        .collect();
    assert_eq!(values, ["", "\"https://example.com\""]);
}

#[test]
fn css_values_remain_opaque_while_timing_calls_are_structured() {
    let source = "motion a { state on { target { timing: var(--x, 1); content: \\); --x: \\, } } transition { timing /* note */: tween(duration: 1ms) } }";
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let motion = parsed.root.motions().next().unwrap();
    let css = motion
        .states()
        .next()
        .unwrap()
        .targets()
        .next()
        .unwrap()
        .properties()
        .next()
        .unwrap();
    assert!(css.value_node().unwrap().timing_call().is_none());
    let timing = motion
        .transitions()
        .next()
        .unwrap()
        .properties()
        .next()
        .unwrap();
    assert!(timing.value_node().unwrap().timing_call().is_some());
}

#[test]
fn unquoted_urls_are_rejected_including_relative_and_protocol_relative_urls() {
    for value in [
        "https://example.com",
        "url(image.png)",
        "url(https://example.com)",
        "url(//example.com)",
        "url()",
    ] {
        let source = format!("motion a {{ state idle {{ body {{ background: {value} }} }} }}");
        let result = parse(&source);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "syntax.url"),
            "{value}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn comments_and_tabs_separate_parameter_binding_and_condition_tokens() {
    for source in [
        "motion a(checked /* input */ :\tboolean) { state idle {} state active when\tchecked {} }",
        "motion a { let\tmovement = drag(target: body); state idle { body { opacity: 1 } } }",
    ] {
        let parsed = parse(source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{source}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.root.text(), source);
    }
}
