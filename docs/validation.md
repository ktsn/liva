# Implementation decisions and validation

## Syntax (E1)

The syntax crate uses Rowan 0.17 with whole-document parsing and typed `Ast` views.
Byte offsets refer to UTF-8 input. Strings, comments, and escapes are atomic during
boundary scanning; CSS values remain opaque. Blocks are limited to 64 levels to
bound recursive parsing of hostile input. Unclosed value groups recover at an
unquoted closing brace; unterminated strings retain the remaining source.

Run `cargo test --workspace`, `cargo fmt --all --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`.
The syntax tests round-trip every character-boundary prefix of the language
example and malformed Unicode/CRLF fixtures, check diagnostic byte ranges, generic
calls, delimiter recovery, identifiers, and context-sensitive opaque values.
The Rowan experiment passes these losslessness and recovery checks.

Toolchain: Rust 1.97.1; dependency versions are recorded in Cargo.lock.

## Compiler and Node boundary (E2)

Rust owns timing signatures, duplicate/reference checks, MVP completeness, and
all-pairs effective transition validation. Definition IR preserves layers and
explicit frames; it never synthesizes endpoints. Development mappings use semantic
paths with structural `target` and `property` segments to avoid name collisions.
Mappings contain half-open UTF-8 ranges in a separate optional envelope; the caller
associates them with the full-file revision. Production consumers retain only
`schemaVersion` and `definitions`.

`fixtures/toggle.json` fixes the schema against the language example. Run the Rust
checks above, then `scripts/build-wasm.sh` and `node scripts/test-wasm.mjs`.
The Node test loads the actual `wasm-bindgen --target nodejs` artifact, compares
Rust serialization with the fixture, verifies the deeply frozen TypeScript view,
rejects unsupported schemas, and slices Unicode source using UTF-8 mappings.
These checks pass on Node 24.22.1 and wasm-bindgen 0.2.127. The CLI version must
match the pinned Rust dependency. No browser APIs are needed by the compiler.

The boundary uses JSON strings rather than JS object bindings. This keeps one
serialization contract and avoids coupling compiler data to JavaScript handles.
See the [wasm-bindgen Node deployment reference](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html).
