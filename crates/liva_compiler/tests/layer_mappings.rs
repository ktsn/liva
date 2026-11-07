mod support;

use liva_compiler::compile;
use support::valid;

#[test]
fn layer_mapping_ranges_preserve_unicode_crlf_expressions_and_shared_origins() {
    let source = "// 😀 日本語\r\nmotion sample(amount: number) {\r\n let quick = tween(duration: 200)\r\n @quick layer base {\r\n @spring(duration: 400) body {\r\n color: '日本語';\r\n opacity: ${amount} @tween(duration: 150);\r\n @quick scale { 0%: ${amount} @steps(count: 3); 100%: 1 }\r\n }\r\n }\r\n}";
    let result = valid(source);
    let mappings = result.mappings.unwrap();

    for (path, expected) in [
        ("sample/layer/base/timing", "quick"),
        (
            "sample/layer/base/target/body/timing",
            "spring(duration: 400)",
        ),
        (
            "sample/layer/base/target/body/property/color/value",
            "'日本語'",
        ),
        (
            "sample/layer/base/target/body/property/opacity/value",
            "${amount}",
        ),
        (
            "sample/layer/base/target/body/property/opacity/timing",
            "tween(duration: 150)",
        ),
        (
            "sample/layer/base/target/body/property/scale/timing",
            "quick",
        ),
        (
            "sample/layer/base/target/body/property/scale/frame/0/offset",
            "0%",
        ),
        (
            "sample/layer/base/target/body/property/scale/frame/0/value",
            "${amount}",
        ),
        (
            "sample/layer/base/target/body/property/scale/frame/0/easing",
            "steps(count: 3)",
        ),
    ] {
        let field = &mappings[path];

        assert_eq!(
            source[field.range.start..field.range.end].trim(),
            expected,
            "{path}"
        );
    }

    assert!(!mappings.contains_key("sample/layer/base/target/body/property/color/timing"));
}

#[test]
fn production_omits_layer_source_mappings() {
    let source = "motion sample { @tween() layer base { body { opacity: 1 } } }";
    let production = compile(source, false);

    assert!(production.diagnostics.is_empty());
    assert!(production.mappings.is_none());
}

#[test]
fn duplicate_transition_pairs_have_distinct_declaration_and_expression_ranges() {
    let source = "motion sample { layer machine { state idle initial { body { opacity: 1 } } @tween(duration: 100) transition idle -> idle when false { body { opacity { 50%: 0.4 @stepStart } } } @tween(duration: 200) transition idle -> idle when false { body { opacity { 50%: 0.8 @stepEnd } } } } }";
    let result = valid(source);
    let mappings = result.mappings.unwrap();

    for (index, value, easing) in [(0, "0.4", "stepStart"), (1, "0.8", "stepEnd")] {
        let path = format!(
            "sample/layer/machine/transition/{index}/target/body/property/opacity/frame/0.5"
        );
        let field = &mappings[&format!("{path}/value")];
        let curve = &mappings[&format!("{path}/easing")];

        assert_eq!(source[field.range.start..field.range.end].trim(), value);
        assert_eq!(source[curve.range.start..curve.range.end].trim(), easing);
    }
}
