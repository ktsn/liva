use liva_syntax::{ast::AstNode, parse};

#[test]
fn event_structure_diagnostics_preserve_source_and_point_to_the_header() {
    for (body, message) in [
        (
            "on /* event */ pointer.release {} layer base {}",
            "on blocks belong directly inside a stateful layer",
        ),
        (
            "layer base { on /* event */ pointer.release {} }",
            "on blocks belong directly inside a stateful layer",
        ),
        (
            "layer base { state idle initial {} @tween() on /* event */ pointer.release {} }",
            "on blocks contain only layer transitions and accept no decorator",
        ),
        (
            "layer base { state idle initial {} on /* event */ pointer.release { opacity: 1 } }",
            "on blocks contain only layer transitions and accept no decorator",
        ),
    ] {
        let source = format!("// 😀\nmotion example {{ {body} }}");
        let parsed = parse(&source);
        let diagnostics: Vec<_> = parsed
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "syntax.event")
            .collect();

        assert_eq!(parsed.root.text(), source);
        assert_eq!(diagnostics.len(), 1, "{body}: {:?}", parsed.diagnostics);
        assert_eq!(diagnostics[0].message, message);
        assert_eq!(
            &source[diagnostics[0].range.start..diagnostics[0].range.end],
            "on /* event */ pointer.release"
        );
    }
}
