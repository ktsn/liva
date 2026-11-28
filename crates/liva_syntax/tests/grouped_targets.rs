use liva_syntax::{
    ast::{AstNode, Target},
    parse,
};

#[test]
fn target_lists_are_lossless_and_expose_each_reference_range() {
    let source = "// 日本😀\r\nmotion sample { layer base { self, /* a */ icon,\r\n label { opacity: 1 } } }";
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    let target = parsed
        .root
        .syntax()
        .descendants()
        .find_map(Target::cast)
        .unwrap();
    let refs = target.references();
    assert_eq!(
        refs.iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["self", "icon", "label"]
    );
    for (name, range) in refs {
        assert_eq!(&source[range.start..range.end], name);
    }
}

#[test]
fn target_groups_reject_css_selectors_and_missing_members() {
    for header in [
        "self,",
        ", icon",
        "self,,icon",
        "self icon",
        ".icon, self",
        "self > icon",
        "icon:hover, self",
    ] {
        let source = format!("motion sample {{ layer base {{ {header} {{ opacity: 1 }} }} }}");
        assert!(!parse(&source).diagnostics.is_empty(), "{source}");
    }
}

#[test]
fn keyword_spelled_groups_are_lossless_and_do_not_capture_conditions() {
    for header in [
        "state, when",
        "layer, when",
        "transition, icon, when",
        "on, when",
    ] {
        let source = format!(
            "motion sample {{ layer base {{ state idle initial {{ {header} {{ scale: 1 }} }} }} }}"
        );
        let parsed = parse(&source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{source}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.root.text(), source);
        let target = parsed
            .root
            .syntax()
            .descendants()
            .find_map(Target::cast)
            .unwrap();
        assert_eq!(
            target
                .references()
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            header.split(", ").collect::<Vec<_>>()
        );
    }
}
