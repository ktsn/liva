# Compiler review checks

Apply these checks to changes affecting `crates/liva_syntax`, `crates/liva_compiler`, or `crates/liva_wasm`.

- **Source fidelity and recovery.** Check that the CST preserves tokens, comments, and whitespace. For incomplete or malformed input, verify that parsing recovers where possible and diagnostics identify the cause or the appropriate insertion point.
- **Representation.** Reuse typed AST accessors and normalize equivalent forms into the existing Definition IR where they share a contract. Check whether language constructs that need special handling can use existing name resolution or function handling.
- **Output boundary.** Keep Definition IR immutable, serializable, and independent of Vue, the DOM, and mutable runtime state. If WASM JSON or source mappings change, check that consumers and serialization fixtures account for the change.
- **Language tooling.** For language changes, verify that the LSP and editor extensions support the updated behavior. Check affected diagnostics, hover information, completions, and syntax highlighting as applicable. See [Other review checks](other.md) for editor verification.
