use liva_syntax::{
    ast::{
        AstNode, HasHeader, HasItems, HasValue, Motion, MotionItem, Property, State, Target,
        Transition, TransitionSelector, expression::Expr,
    },
    parse,
};

#[test]
fn structural_views_expose_parameters_bindings_states_and_transition_tracks() {
    let source = r#"motion demo( /* 😀 */ progress: number,
 enabled: boolean, label: string) {
  let doubled = progress * 2
  state idle { body { opacity: ${doubled} } }
  state active when progress > 0 { body { opacity: 1 } }
  transition idle -> active {
    body {
      opacity {
        @tween: 100ms
        0%: 0 @ linear
        100%: 1
      }
    }
  }
}"#;
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let motion = parsed.root.motions().next().unwrap();
    let parameter = motion.parameters().next().unwrap();
    let binding = motion.bindings().next().unwrap();

    assert_eq!(motion.name().as_deref(), Some("demo"));
    assert_eq!(
        motion
            .parameters()
            .map(|parameter| (
                parameter.header().unwrap(),
                parameter.type_reference().unwrap().semantic_text()
            ))
            .collect::<Vec<_>>(),
        [
            ("progress".into(), "number".into()),
            ("enabled".into(), "boolean".into()),
            ("label".into(), "string".into()),
        ]
    );
    assert_eq!(parameter.header().as_deref(), Some("progress"));
    assert_eq!(parameter.type_reference().unwrap().text().trim(), "number");
    assert_eq!(binding.header().as_deref(), Some("doubled"));
    assert_eq!(
        binding.initializer().unwrap().operator().as_deref(),
        Some("*")
    );

    let states: Vec<_> = motion.states().collect();
    assert_eq!(states.len(), 2);
    assert_eq!(states[0].name().as_deref(), Some("idle"));
    assert!(states[0].condition().is_none());
    let condition = states[1].condition().unwrap().expression().unwrap();
    assert_eq!(condition.operator().as_deref(), Some(">"));

    let target = states[0].targets().next().unwrap();
    let property = target.properties().next().unwrap();
    let interpolation = property
        .value_node()
        .unwrap()
        .interpolations()
        .next()
        .unwrap();
    assert_eq!(target.header().as_deref(), Some("body"));
    assert_eq!(property.header().as_deref(), Some("opacity"));
    assert_eq!(interpolation.expression().unwrap().text(), "doubled");

    let transition = motion.transitions().next().unwrap();
    assert_eq!(
        transition.selector(),
        Some(TransitionSelector::Directional {
            from: "idle".into(),
            to: "active".into()
        })
    );
    let track = transition
        .targets()
        .next()
        .unwrap()
        .property_blocks()
        .next()
        .unwrap();
    let frame = track.keyframes().next().unwrap();
    assert_eq!(track.header().as_deref(), Some("opacity"));
    assert_eq!(frame.header().as_deref(), Some("0%"));
    assert_eq!(frame.value_text().as_deref(), Some("0 @ linear"));
    assert_eq!(
        track
            .properties()
            .map(|property| property.header().unwrap())
            .collect::<Vec<_>>(),
        ["@tween", "0%", "100%"]
    );

    assert_range(source, &motion);
    assert_range(source, &parameter);
    assert_range(source, &binding);
    assert_range(source, &condition);
    assert_range(source, &target);
    assert_range(source, &property);
    assert_range(source, &interpolation);
    assert_range(source, &transition);
    assert_range(source, &track);
    assert_range(source, &frame);
}

fn assert_range(source: &str, node: &impl AstNode) {
    let range = node.range();
    assert_eq!(&source[range.start..range.end], node.text());
    assert_eq!(
        node.syntax().ancestors().last().unwrap().text().to_string(),
        source
    );
}

#[test]
fn casts_distinguish_structural_roles_without_discarding_invalid_items() {
    let parsed = parse(
        "motion demo { state idle { state { opacity: 1 } } unknown {} transition broken {} }",
    );
    let motion = parsed.root.motions().next().unwrap();
    let target = motion.states().next().unwrap().targets().next().unwrap();

    assert!(Target::cast(target.syntax().clone()).is_some());
    assert!(State::cast(target.syntax().clone()).is_none());
    assert!(Motion::cast(target.syntax().clone()).is_none());
    assert!(Property::cast(target.syntax().clone()).is_none());
    assert!(Expr::cast(target.syntax().clone()).is_none());
    assert!(Transition::cast(motion.syntax().clone()).is_none());

    let items: Vec<_> = motion.items().collect();
    assert!(matches!(&items[0], MotionItem::State(_)));
    assert!(
        matches!(&items[1], MotionItem::Invalid(block) if block.header().as_deref() == Some("unknown"))
    );
    assert!(
        matches!(&items[2], MotionItem::Transition(transition) if transition.selector().is_none())
    );
}

#[test]
fn motion_accessors_expose_lifecycle_tracks_and_event_expressions() {
    let source = r#"// 日本語
motion panel(enabled: boolean) {
  event shown when enabled
  state idle { body { opacity: 1 } }
  enter { body { opacity { @tween: 100ms; 0%: 0 } } }
  transition { @tween: 200ms }
  leave { body { opacity { @tween: 150ms; 100%: 0 } } }
  event hidden when !enabled
}
motion other { state idle {} }
"#;
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    let mut motions = parsed.root.motions();
    let motion = motions.next().unwrap();

    for (animations, selector, offset) in [
        (
            motion.enters().collect::<Vec<_>>(),
            TransitionSelector::Enter,
            "0%",
        ),
        (
            motion.leaves().collect::<Vec<_>>(),
            TransitionSelector::Leave,
            "100%",
        ),
    ] {
        assert_eq!(animations.len(), 1);
        let animation = &animations[0];
        assert_eq!(animation.selector(), Some(selector));
        let target = animation.targets().next().unwrap();
        let property = target.property_blocks().next().unwrap();
        let frame = property.keyframes().next().unwrap();

        assert_eq!(target.header().as_deref(), Some("body"));
        assert_eq!(property.header().as_deref(), Some("opacity"));
        assert_eq!(frame.header().as_deref(), Some(offset));
        assert_range(source, animation);
        assert_range(source, &frame);
    }

    let events = motion.events().collect::<Vec<_>>();
    assert_eq!(events.len(), 2);

    for (event, name, expression) in [
        (&events[0], "shown", "enabled"),
        (&events[1], "hidden", "!enabled"),
    ] {
        let condition = event.condition().unwrap();
        let expression_node = condition.expression().unwrap();

        assert_eq!(event.name().as_deref(), Some(name));
        assert_eq!(expression_node.semantic_text(), expression);
        assert_range(source, event);
        assert_range(source, &condition);
        assert_range(source, &expression_node);
    }

    assert_eq!(motion.transitions().count(), 3);
    let other = motions.next().unwrap();
    assert_eq!(other.enters().count(), 0);
    assert_eq!(other.leaves().count(), 0);
    assert_eq!(other.events().count(), 0);
}

#[test]
fn lifecycle_accessors_retain_duplicate_and_malformed_declarations() {
    let source = "motion panel {
  enter invalid extra {}
  enter {}
  leave invalid extra {}
  leave {}
  event missing
  event when true
  event valid when true
  state idle {}
}";
    let parsed = parse(source);
    assert!(!parsed.diagnostics.is_empty());
    assert_eq!(parsed.root.text(), source);
    let motion = parsed.root.motions().next().unwrap();

    for animations in [
        motion.enters().collect::<Vec<_>>(),
        motion.leaves().collect::<Vec<_>>(),
    ] {
        assert_eq!(animations.len(), 2);
        assert!(animations[0].selector().is_none());
        assert!(animations[1].selector().is_some());

        for animation in animations {
            assert_range(source, &animation);
        }
    }

    let events = motion.events().collect::<Vec<_>>();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].name().as_deref(), Some("missing"));
    assert!(events[0].condition().is_none());
    assert!(events[1].name().is_none());
    assert!(events[1].condition().unwrap().expression().is_some());
    assert_eq!(events[2].name().as_deref(), Some("valid"));

    for event in events {
        assert_range(source, &event);
    }

    assert_eq!(motion.states().count(), 1);
}
