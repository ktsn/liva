use liva_syntax::{
    ast::{AstNode, HasHeader, TransitionSelector},
    parse,
};

#[test]
fn lifecycle_keywords_are_scoped_to_motion_animation_blocks() {
    for phase in ["enter", "leave"] {
        let source = format!(
            "motion panel {{ state idle {{ {phase} {{ opacity: 1 }} }} {phase} {{ {phase} {{ @tween(duration: 1) opacity {{ 0%: 0 }} }} }} }}"
        );
        let parsed = parse(&source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{source}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.root.text(), source);
        let motion = parsed.root.motions().next().unwrap();

        assert_eq!(motion.transitions().count(), 1);
        assert_eq!(
            motion
                .states()
                .next()
                .unwrap()
                .targets()
                .next()
                .unwrap()
                .header()
                .as_deref(),
            Some(phase)
        );
        let animation = motion.transitions().next().unwrap();
        assert_eq!(
            animation.targets().next().unwrap().header().as_deref(),
            Some(phase)
        );
        assert_eq!(
            animation.selector(),
            Some(if phase == "enter" {
                TransitionSelector::Enter
            } else {
                TransitionSelector::Leave
            })
        );
    }
}

#[test]
fn lifecycle_headers_reject_directions_conditions_and_invalid_names() {
    for phase in ["enter", "leave"] {
        for suffix in ["idle", "idle -> active", "when ready", "(ready)", "123bad"] {
            let source = format!("motion panel {{ state idle {{}} {phase} {suffix} {{}} }}");
            let parsed = parse(&source);

            assert_eq!(parsed.root.text(), source);
            let error = parsed
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.code == "syntax.name")
                .unwrap();
            assert_eq!(
                source[error.range.start..error.range.end].trim(),
                format!("{phase} {suffix}")
            );
            assert!(
                parsed
                    .root
                    .motions()
                    .next()
                    .unwrap()
                    .transitions()
                    .next()
                    .unwrap()
                    .selector()
                    .is_none()
            );
        }
    }
}

#[test]
fn lifecycles_and_mixed_properties_keep_lossless_typed_views() {
    use liva_syntax::ast::{AnimationProperty, HasValue};

    for phase in ["enter", "leave"] {
        let source = format!(
            "// 日本語 😀\r\nmotion panel {{ state idle {{}} {phase} /* lifecycle */ {{ body {{\r\nopacity: 0 /* value */\r\ntranslate: ${{distance}}px 0\r\nscale {{ 50%: 1.1 @ ease-out }}\r\n}} }} }}"
        );
        let parsed = parse(&source);
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        assert_eq!(parsed.root.text(), source);

        let animation = parsed
            .root
            .motions()
            .next()
            .unwrap()
            .transitions()
            .next()
            .unwrap();
        assert_eq!(
            animation.selector(),
            Some(if phase == "enter" {
                TransitionSelector::Enter
            } else {
                TransitionSelector::Leave
            })
        );
        let properties: Vec<_> = animation
            .targets()
            .next()
            .unwrap()
            .animation_properties()
            .collect();
        assert_eq!(properties.len(), 3);
        let AnimationProperty::Shorthand(property) = &properties[1] else {
            panic!("Expected shorthand")
        };
        assert_eq!(property.header().as_deref(), Some("translate"));
        assert_eq!(property.value_text().as_deref(), Some("${distance}px 0"));
        assert_eq!(
            &source[property.range().start..property.range().end],
            property.text()
        );
        assert_eq!(property.value_node().unwrap().interpolations().count(), 1);
        assert!(matches!(&properties[2], AnimationProperty::Keyframes(_)));
    }
}
