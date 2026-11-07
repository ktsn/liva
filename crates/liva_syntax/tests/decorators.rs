use liva_syntax::{
    Kind,
    ast::{AstNode, HasHeader, HasItems, HasValue},
    parse,
};

#[test]
fn all_decorator_positions_are_lossless_and_separate_from_css() {
    let source = "motion button { state idle { @quick body { opacity: 1 @tween(duration: 150); @quick translate ~> { 0%: 0 20px @easeOut; 100%: 0 0 } } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    assert_eq!(
        parsed
            .root
            .syntax()
            .descendants()
            .filter(|node| node.kind() == Kind::Decorator)
            .count(),
        4
    );

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

    assert_eq!(target.header().as_deref(), Some("body"));
    assert_eq!(
        target.properties().next().unwrap().value_text().as_deref(),
        Some("1")
    );
}

#[test]
fn shared_headers_expose_lossless_decorators_and_guarded_transitions() {
    let source = "// 日本語\r\nmotion sample(active: boolean) {\r\n@tween(duration: 200) layer base {\r\n@quick state idle initial {}\r\n@quick state on {}\r\n@spring(duration: 400)\r\n transition idle -> on\r\n when active {}\r\n@quick\r\n transition on -> idle\r\n when !active\r\n}\r\n@quick enter {}\r\n@quick leave {}\r\n}";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();
    let decorator = layer.decorators().next().unwrap();
    let range = decorator.expression_range();

    assert_eq!(&source[range.start..range.end], decorator.expression_text());
    assert_eq!(decorator.expression_text().trim(), "tween(duration: 200)");
    assert!(layer.states().next().unwrap().is_initial());
    assert_eq!(layer.transitions().count(), 2);
    assert!(
        layer
            .transitions()
            .all(|transition| transition.condition().is_some())
    );
    assert_eq!(motion.enters().next().unwrap().decorators().count(), 1);
    assert_eq!(motion.leaves().next().unwrap().decorators().count(), 1);
}

#[test]
fn malformed_shared_decorators_keep_following_declarations_accessible() {
    let source =
        "motion sample { @() layer base { state idle initial {} state on {} } @quick leave {} }";
    let parsed = parse(source);
    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();

    assert_eq!(parsed.root.text(), source);
    assert_eq!(
        layer.decorators().next().unwrap().expression_text().trim(),
        "()"
    );
    assert_eq!(layer.states().count(), 2);
    assert_eq!(motion.leaves().count(), 1);
}

#[test]
fn prefixes_attach_to_the_next_structure_with_expression_boundaries() {
    for separator in [" ", "\n", " /* 日本語 */\r\n"] {
        let source = format!(
            "motion sample(active: boolean) {{ @tween(duration: 100 + 50){separator}layer base {{\n@quick{separator}state off initial {{}}\nstate on {{}}\n@(quick){separator}transition off -> on when active\n@quick{separator}transition on -> off when !active {{\n@quick{separator}body {{\n@(quick){separator}opacity ~> {{ 0%: 0 @easeOut; 100%: 1 }}\n}}\n}}\n}}\n@quick{separator}enter {{}}\n@quick{separator}leave {{}}\n}}"
        );
        let parsed = parse(&source);

        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert_eq!(parsed.root.text(), source);

        let motion = parsed.root.motions().next().unwrap();
        let layer = motion.layers().next().unwrap();
        let transitions: Vec<_> = layer.transitions().collect();

        assert_eq!(layer.name().as_deref(), Some("base"));
        assert_eq!(transitions.len(), 2);
        assert_eq!(
            transitions[0]
                .decorators()
                .next()
                .unwrap()
                .expression_text(),
            "(quick)"
        );
        assert_eq!(
            transitions[1].targets().next().unwrap().header().as_deref(),
            Some("body")
        );
        assert_eq!(layer.states().nth(1).unwrap().decorators().count(), 0);

        for decorator in parsed
            .root
            .syntax()
            .descendants()
            .filter_map(liva_syntax::ast::Decorator::cast)
        {
            let range = decorator.expression_range();

            assert_eq!(&source[range.start..range.end], decorator.expression_text());
        }
    }
}

#[test]
fn malformed_headers_preserve_source_and_following_layers() {
    for header in [
        "layer base @quick {}",
        "layer base { state off initial @quick {} state on {} transition off -> on @quick when true }",
        "enter @quick {}",
        "leave { body @quick { opacity @quick {} } }",
    ] {
        let source = format!("motion sample {{ {header}\nlayer next {{}} }}");
        let parsed = parse(&source);

        assert_eq!(parsed.root.text(), source);
        assert!(
            parsed
                .root
                .motions()
                .next()
                .unwrap()
                .layers()
                .any(|layer| layer.name().as_deref() == Some("next"))
        );
    }
}

#[test]
fn prefixes_on_values_and_non_decoratable_declarations_are_rejected() {
    for source in [
        "@quick motion sample { layer base {} }",
        "motion sample { @quick let value = 1\nlayer base {} }",
        "motion sample { @quick event done when true\nlayer base {} }",
        "motion sample { layer base { body { @quick opacity: 1 } } }",
        "motion sample { layer base { body { opacity ~> { @easeOut 0%: 0; 100%: 1 } } } }",
    ] {
        let parsed = parse(source);

        assert_eq!(parsed.root.text(), source);
        assert!(!parsed.diagnostics.is_empty(), "{source}");
    }
}

#[test]
fn prefix_expressions_accept_keyword_named_bindings_and_nested_calls() {
    let source = "motion sample { let layer = tween()\n@layer layer base { @tween(duration: 100 * (2 + 1)) body { opacity: 1 } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    assert_eq!(
        parsed
            .root
            .motions()
            .next()
            .unwrap()
            .layers()
            .next()
            .unwrap()
            .decorators()
            .next()
            .unwrap()
            .expression_text(),
        "layer"
    );
}
