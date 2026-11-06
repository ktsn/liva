use liva_syntax::{
    ast::{AstNode, HasHeader, HasItems, HasValue, expression::Expr},
    parse,
};

#[test]
fn every_prefix_preserves_source_ranges_and_supports_ast_access() {
    for source in [
        include_str!("../../../fixtures/toggle.liv"),
        include_str!("../../../fixtures/card.liv"),
        include_str!("../../../fixtures/reactive-toggle.liv"),
        include_str!("../../../fixtures/derived.liv"),
        include_str!("../../../fixtures/presence.liv"),
        "日本語 {\r\n x: '\"😀' /* } */; y: var(--a, [a,b])\r\n}",
        "motion a { @tween: 1ms unknown( fn([1, 2], '),'), b: 1,) }",
        "motion a { @tween: 1ms x( \"unfinished",
        "motion a { /* unterminated",
        "motion progress( /* 😀 */ value: number,\r\n enabled: boolean, label: string) { state idle {} }",
        "motion card { let movement=custom(\r\n target: /* 😀 */ body,\r\n)\r\n state idle { body { opacity: 1 } } }",
        "motion demo { let value = custom(label: '日本😀', value: -(other.member + 2)); state when {} state active when value > 0 { body { opacity: ${value * 2} } } }",
        "motion demo( /* 😀 */ progress: number) { let value = progress + 1; state idle { body { opacity: ${value} } } transition { body { opacity { 0%: 0 } } } }",
        r#"motion demo(max-value: number) { let value = max-value - 1; state idle { body { width: 20px; content: "\41 ${'😀}'} ${value} \n" } } }"#,
    ] {
        for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
            assert_recoverable(&source[..end]);
        }
    }
}

fn assert_recoverable(source: &str) {
    let parsed = parse(source);
    assert_eq!(parsed.root.text(), source);

    for diagnostic in &parsed.diagnostics {
        let range = &diagnostic.range;
        assert!(
            range.start <= range.end && range.end <= source.len(),
            "{source}: {diagnostic:?}"
        );
        assert!(source.is_char_boundary(range.start));
        assert!(source.is_char_boundary(range.end));
    }

    for motion in parsed.root.motions() {
        let _ = motion.name();
        for parameter in motion.parameters() {
            let _ = (parameter.header_node(), parameter.type_reference());
        }
        for binding in motion.bindings() {
            let _ = (binding.header_node(), binding.initializer());
        }
        for state in motion.states() {
            let _ = (
                state.name(),
                state.condition().and_then(|node| node.expression()),
            );
            for target in state.targets() {
                for property in target.properties() {
                    let _ = (property.header_node(), property.value_node());
                }
            }
        }
        for event in motion.events() {
            let _ = (
                event.name(),
                event.condition().and_then(|node| node.expression()),
            );
        }
        let _ = (motion.enters().count(), motion.leaves().count());

        for transition in motion.transitions() {
            let _ = transition.selector();
            for target in transition.targets() {
                for property in target.property_blocks() {
                    for frame in property.keyframes() {
                        let _ = frame.header_node();
                    }
                }
            }
        }
    }

    for expression in parsed.root.syntax().descendants().filter_map(Expr::cast) {
        let _ = (
            expression.view(),
            expression.operands().count(),
            expression.operator(),
            expression.names().count(),
            expression.function(),
        );
        for argument in expression.arguments() {
            let _ = (argument.name(), argument.value());
        }
    }
}

#[test]
fn malformed_headers_and_groups_do_not_consume_later_motions() {
    for broken in [
        "broken\n",
        "motion a { state on { t { x: fn(1 } } } ",
        "motion broken(value: { state idle {} } ",
        "motion broken(value { state idle {} } ",
        "motion broken(,) { state idle {} } ",
    ] {
        let source = format!("{broken}motion valid {{ state idle {{}} }}");
        let parsed = parse(&source);
        assert!(!parsed.diagnostics.is_empty(), "{source}");
        assert_eq!(parsed.root.text(), source);
        assert_eq!(
            parsed.root.motions().last().unwrap().name().as_deref(),
            Some("valid")
        );
    }
}

#[test]
fn incomplete_interpolation_recovers_at_newline_and_preserves_later_properties() {
    let source = "motion a { state idle { body { opacity: ${missing\nscale: 1\n} } }";
    let parsed = parse(source);
    assert_eq!(parsed.root.text(), source);
    let properties: Vec<_> = parsed
        .root
        .motions()
        .next()
        .unwrap()
        .states()
        .next()
        .unwrap()
        .targets()
        .next()
        .unwrap()
        .properties()
        .map(|property| property.header().unwrap())
        .collect();
    assert_eq!(properties, ["opacity", "scale"]);
    let error = parsed
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "syntax.interpolation")
        .unwrap();
    assert_eq!(&source[error.range.start..error.range.end], "${missing");
}

#[test]
fn malformed_motion_declarations_recover_before_following_declarations() {
    for declaration in [
        "enter",
        "leave",
        "event",
        "event dismissed",
        "event dismissed when",
        "event dismissed when !",
        "event dismissed when true &&",
        "event dismissed when (",
    ] {
        let source = format!(
            "motion broken {{
{declaration}
state idle {{}}
leave {{}}
event valid when true
}}
motion other {{ state idle {{}} }}"
        );
        let parsed = parse(&source);
        assert!(!parsed.diagnostics.is_empty(), "{source}");
        assert_recoverable(&source);

        let motion = parsed.root.motions().next().unwrap();
        assert_eq!(motion.states().count(), 1, "{source}");
        assert_eq!(motion.leaves().count(), 1, "{source}");
        assert_eq!(
            motion.events().last().unwrap().name().as_deref(),
            Some("valid"),
            "{source}"
        );
        assert_eq!(
            parsed.root.motions().last().unwrap().name().as_deref(),
            Some("other")
        );
    }
}

#[test]
fn unclosed_event_conditions_recover_at_every_motion_declaration() {
    for declaration in [
        "state idle {}",
        "state active when true {}",
        "enter {}",
        "leave {}",
        "transition {}",
        "transition idle -> active {}",
        "event valid when true",
        "let valid = true",
    ] {
        let source = format!("motion broken {{ event missing when (\n{declaration}\n}}");
        let parsed = parse(&source);
        assert!(!parsed.diagnostics.is_empty(), "{source}");
        assert_recoverable(&source);
        let motion = parsed.root.motions().next().unwrap();

        let recovered = motion
            .syntax()
            .children()
            .filter(|node| node.kind() != liva_syntax::Kind::Header)
            .map(|node| node.semantic_text())
            .collect::<Vec<_>>();
        assert_eq!(recovered, ["event missing when (", declaration], "{source}");
    }
}
