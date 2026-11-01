use liva_compiler::compile;
use liva_syntax::{Diagnostic, Range};

pub fn motion(body: &str) -> String {
    format!(
        "// 日本語 😀\r\nmotion a(enabled: boolean, amount: number, label: string) {{\nstate idle {{ body {{ opacity: 1; translate: 0 0 }} badge {{ opacity: 1 }} }}\n{body}\n}}"
    )
}

pub fn assert_error(body: &str, code: &str) -> Diagnostic {
    let marked = motion(body);
    let start = marked.find('«').expect("Expected marked diagnostic start");
    let end = marked.find('»').expect("Expected marked diagnostic end") - '«'.len_utf8();
    let source = marked.replace(['«', '»'], "");
    let result = compile(&source, true);
    let errors: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == "error" && diagnostic.code == code)
        .collect();

    assert!(
        result.definitions.is_empty(),
        "{source}: {:?}",
        result.diagnostics
    );
    assert_eq!(errors.len(), 1, "{source}: {:?}", result.diagnostics);
    assert_eq!(
        errors[0].range,
        Range { start, end },
        "{source}: {:?}",
        result.diagnostics
    );

    errors[0].clone()
}

pub fn assert_recovers(body: &str) {
    let source = format!("{}\nmotion valid {{ state idle {{}} }}", motion(body));
    let result = compile(&source, false);

    assert_eq!(
        result
            .definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        ["valid"],
        "{source}: {:?}",
        result.diagnostics,
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    );
}
