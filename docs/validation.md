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
