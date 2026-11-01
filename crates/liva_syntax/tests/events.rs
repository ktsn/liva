use liva_syntax::{ast::AstNode, parse};

#[test]
fn event_conditions_preserve_comments_separators_and_multiline_expressions() {
    for condition in [
        "ready",
        "ready\n && enabled",
        "ready\r\n || enabled",
        "(ready\n && enabled)",
        "(state\n || enter)",
        "ready /* 日本語 */\n // comment\n && enabled",
    ] {
        for separator in [";", "\n", "\r\n"] {
            let source = format!(
                "motion panel {{ event /* 😀 */ shown /* name */ when {condition}{separator}event hidden when !ready{separator}state idle {{}} }}"
            );
            let parsed = parse(&source);
            assert!(
                parsed.diagnostics.is_empty(),
                "{source}: {:?}",
                parsed.diagnostics
            );
            assert_eq!(parsed.root.text(), source);

            let motion = parsed.root.motions().next().unwrap();
            let events = motion.events().collect::<Vec<_>>();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].name().as_deref(), Some("shown"));
            assert_eq!(events[1].name().as_deref(), Some("hidden"));
            assert!(events[0].condition().unwrap().expression().is_some());
            assert_eq!(motion.states().count(), 1);
        }
    }
}

#[test]
fn events_are_rejected_outside_the_motion_body() {
    for source in [
        "event done when true
motion panel { state idle {} }",
        "motion panel { state idle { event done when true
 } }",
        "motion panel { state idle { body { event done when true
 } } }",
        "motion panel { state idle {} enter { event done when true
 } }",
        "motion panel { state idle {} leave { body { opacity { event done when true
 } } } }",
    ] {
        let parsed = parse(source);
        assert_eq!(parsed.root.text(), source);
        let error = parsed
            .diagnostics
            .iter()
            .find(|diagnostic| {
                diagnostic.message == "Events must be declared directly inside a Motion"
            })
            .unwrap();
        assert_eq!(&source[error.range.start..error.range.end], "event");
        assert_eq!(parsed.root.motions().next().unwrap().events().count(), 0);
    }
}
