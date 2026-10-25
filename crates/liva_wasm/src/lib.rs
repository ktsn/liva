use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compile(source: &str, development: bool) -> String {
    serde_json::to_string(&liva_compiler::compile(source, development))
        .expect("Compiler emits only finite JSON numbers")
}
