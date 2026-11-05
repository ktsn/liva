# Editor support

Liva provides a stdio Language Server and a Zed dev extension. The server supports
`.liv` / `.liva` files and inline top-level `<liva>` blocks in Vue SFCs. Standalone
files are supported for editing; the Vite integration does not support importing them into applications.

## Install in Zed

From the repository root, with the pinned Rust toolchain, Node.js, and pnpm installed:

```sh
rustup target add wasm32-wasip2
cargo install --path crates/liva_lsp --locked
cargo install tree-sitter-cli --version 0.26.3 --locked --root target/tools
export PATH="$PWD/target/tools/bin:$PATH"
export WASI_SDK_PATH="/absolute/path/to/wasi-sdk"
pnpm --dir editors/zed build
```

Install [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) for your host
platform and set `WASI_SDK_PATH` to its extracted directory. An existing SDK downloaded
by Zed can also be used; on macOS it is normally located at
`~/Library/Application Support/Zed/extensions/build/wasi-sdk`.
Ensure `~/.cargo/bin` is on the PATH visible to Zed.

The build generates the parser and compiles it to `editors/zed/grammars/liva.wasm`,
then builds the server adapter as `editors/zed/extension.wasm`. Generated parser
sources and both WASM artifacts are ignored by Git.

Link the built extension into Zed's installed extensions directory. On macOS:

```sh
mkdir -p "$HOME/Library/Application Support/Zed/extensions/installed"
ln -s "$PWD/editors/zed" "$HOME/Library/Application Support/Zed/extensions/installed/liva"
```

On Linux, use `${XDG_DATA_HOME:-$HOME/.local/share}/zed/extensions/installed`.
If Liva is already installed, uninstall it from Zed first, then create the link.
Restart Zed after installing or rebuilding to load the new artifacts.
Keep this checkout at the linked location while the extension is installed.

Use this local build and link workflow instead of **Install Dev Extension**:
Zed's dev builder fetches grammar sources from Git, whereas this extension builds
its bundled grammar locally. The grammar repository metadata in `extension.toml`
registers the grammar name; the local installation loads its compiled WASM directly.
No copied extension directory or separate grammar Git repository is needed.

If Zed cannot find the executable, configure an absolute path in its settings:

```json
{
  "lsp": {
    "liva": {
      "binary": { "path": "/absolute/path/to/liva-lsp" }
    }
  }
}
```

Open `fixtures/derived.liv`. Hover over `scaled` to see `number`, or over
`movement.active` and `movement.offset.x` to see their field types. Change
`progress / divisor` to `progress / true`: a compiler error appears without saving.
Undo the change to clear the diagnostic. The command **editor: hover** also
shows the information at the cursor.

For Vue, install Zed's Vue extension and use `<liva lang="liva">` for syntax
highlighting through its custom-block language injection. Hover and diagnostics
also work in plain `<liva>` blocks. Configure Vue's server priority so Liva hover
is available alongside the Vue server:

```json
{
  "languages": {
    "Vue.js": { "language_servers": ["liva", "..."] }
  }
}
```

The `...` entry keeps the other Vue language servers enabled. Open
`playground/src/pages/drag.vue` to verify the embedded case.
The server checks each inline Liva block independently; `src` blocks and host
JavaScript/TypeScript bindings are not analyzed. Embedded syntax highlighting is
subject to the Vue grammar's custom-block parsing.

After server changes, repeat `cargo install` and run **editor: restart language server**.
After extension or grammar changes, rerun `pnpm --dir editors/zed build` and restart Zed.
Installation failures are recorded by **zed: open log**. In particular,
`wasm32-wasip2` must be installed for the toolchain selected by `rust-toolchain.toml`.

## Architecture and other editors

- `crates/liva_compiler/src/analysis.rs` exposes byte-ranged type hover information.
  It uses the same motion scope, dependency inference, and built-in signatures as
  compilation, including forward references and member types. Invalid definitions
  retain the type information that can still be inferred.
- `crates/liva_lsp` owns document versions, full-text synchronization, UTF-16 LSP
  positions, Vue block mapping, hover, and published compiler diagnostics. Analysis
  uses the open buffer rather than the file on disk; closing clears diagnostics.
- `editors/zed/tree-sitter-liva` contains the highlighting grammar and its tests.
  The Rowan compiler parser remains authoritative for language validation.
- `editors/zed` supplies language configuration, queries, and a small executable
  lookup adapter. It contains no type-checking logic.

Other editors can launch `liva-lsp` with no arguments using standard LSP over
stdin/stdout. Register `liva` for `.liv` and `.liva`, and optionally attach the
same server to Vue documents. The server advertises full document synchronization,
UTF-16 positions, and hover; it publishes diagnostics after open/change and clears
them on close. Completion, formatting, and cross-file resolution are not implemented.

## Verification and grammar changes

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo check --manifest-path editors/zed/Cargo.toml
PATH="$PWD/target/tools/bin:$PATH" pnpm --dir editors/zed test:grammar
```

Run the build command from the installation section after changing `grammar.js`.
Commit grammar sources and tests; do not commit generated `src` files or WASM.
The highlight query lives only in `editors/zed/languages/liva/highlights.scm` and
is also referenced by the grammar's `tree-sitter.json`.

See Zed's [language extension documentation](https://zed.dev/docs/extensions/languages)
and [dev extension installation](https://zed.dev/docs/extensions/developing-extensions)
for the editor's extension interfaces.
