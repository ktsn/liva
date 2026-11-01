use liva_syntax::{
    ast::{AstNode, HasHeader, TransitionSelector},
    parse,
};

#[test]
fn lifecycle_keywords_are_scoped_to_motion_animation_blocks() {
    for phase in ["enter", "leave"] {
        let source = format!(
            "motion panel {{ state idle {{ {phase} {{ opacity: 1 }} }} {phase} {{ {phase} {{ opacity {{ @tween: 1ms; 0%: 0 }} }} }} }}"
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
fn lifecycle_headers_reject_state_selectors_and_conditions() {
    for phase in ["enter", "leave"] {
        for suffix in ["idle -> active", "when ready", "(ready)", "extra"] {
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
