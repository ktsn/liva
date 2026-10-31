pub fn valid(source: &str) -> liva_compiler::Compilation {
    let result = liva_compiler::compile(source, true);
    assert!(
        result
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != "error"),
        "{source}: {:?}",
        result.diagnostics
    );
    result
}
