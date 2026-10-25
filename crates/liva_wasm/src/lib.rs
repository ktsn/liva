use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compile(source: &str, development: bool) -> String {
    serde_json::to_string(&liva_compiler::compile(source, development))
        .expect("Compiler emits only finite JSON numbers")
}

#[wasm_bindgen(js_name = applyEdits)]
pub fn apply_edits(source: &str, edits: &str) -> String {
    let result = serde_json::from_str::<Vec<liva_compiler::edits::Edit>>(edits)
        .map_err(|error| error.to_string())
        .and_then(|edits| liva_compiler::edits::apply_edits(source, &edits));

    match result {
        Ok(result) => serde_json::to_string(&result).expect("Finite compiler output"),
        Err(error) => serde_json::json!({ "error": error }).to_string(),
    }
}
