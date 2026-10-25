fn main() {
    let source = std::fs::read_to_string(std::env::args().nth(1).expect("source path")).unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(&liva_compiler::compile(&source, false)).unwrap()
    );
}
