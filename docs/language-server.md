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
also work in plain `<liva>` blocks. Expression completion suggests registered built-in
functions (including `interaction`) and inferred record members such as `ui.focusVisible`;
a dot triggers member completion. Each suggestion includes its type or function signature. Configure Vue's server priority so Liva hover
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

## Literal types and argument choices

Hover displays inferred string literals (`alias: "x"`), annotated finite unions
(`position: "end" | "start"`), and constrained function signatures using the same
compiler formatter as diagnostics. A `(fixed)` marker on a parameter comes from
signature metadata: its value must have one provable string value in addition to
belonging to the displayed set. For example, `link.component` offers `"x"` and `"y"`
as literal choices, while a changeable `"x" | "y"` parameter still fails compilation.

At an empty constrained argument value, completion offers its permitted strings
alongside expression names. Inside an existing quoted value, it filters choices
by the decoded prefix. Both quote styles and equivalent supported escapes work;
selecting a choice replaces the whole closed value with a correctly escaped,
double-quoted spelling. This also works in nested timing decorators:

```liva
motion sample {
  let curve = steps(count: 4, position: )
  layer base { opacity: 1 @tween(easing: steps(count: 4, position: "ju")) }
}
```

Place the caret after `position:` or inside `"ju"` and request completion.
A colon or opening quote triggers argument completion; a dot still triggers member
completion. Completed closing quotes, type annotations, comments, opaque CSS, and
unrelated strings do not offer expression insertions. Ordinary variable/function
and member completion remains available in expressions, including empty CSS
interpolations.

Choices come from the still-compatible signatures, using the compiler's argument
rules for supplied values. Known incompatible types, configuration constraints,
unknown names and duplicates exclude candidates. Required arguments that are not
yet supplied and other incomplete/unresolved values leave potential signatures open.
The server does not maintain separate option lists or type compatibility rules.

Incomplete quoted prefixes can complete at the end of the input or immediately
before a structural delimiter, preserving following source. When an unfinished
string has ordinary suffix text after the caret, its replacement boundary is
ambiguous and no insertion is offered: close the quote or move to the end of that
literal text. An unfinished escape needs completing or removing the escape before
choices return. Partial annotations/unions retain parser recovery and current
buffer ranges; they do not receive built-in argument choices.

The compiler exposes UTF-8 byte edits; the server maps them to UTF-16 positions in
standalone and Vue buffers. Literal results carry explicit edits and current-prefix
filter text, and request recomputation as typing continues. Closed multiline values
use a single-line main edit containing the caret plus nonoverlapping cleanup edits
in the original buffer's coordinates, following the
[LSP completion edit contract](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md).
Applying all edits replaces only the original literal. Prefix matching remains
exact, so a prefix containing a real newline has no match among today's single-line
built-in options. The Zed grammar highlights quoted type members as strings and the
union separator as an operator.

## Architecture and other editors

- `crates/liva_compiler/src/analysis.rs` and its completion module expose byte-ranged
  type hovers, contextual choices and source edits. They use the same motion scope, dependency inference, and built-in signatures as
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
UTF-16 positions, hover, expression completion, and full semantic tokens. It publishes
diagnostics after open/change and clears them on close. Formatting and cross-file
resolution are not implemented.

`self` uses the theme-controlled Tree-sitter capture `variable.builtin` in Zed,
for both explicit target blocks and expression references. The LSP emits semantic
`variable` tokens with `readonly` and `defaultLibrary` modifiers for the same built-in
target, including mapped Vue custom blocks; named targets keep their syntax scopes.
Clients/themes choose the displayed colors. Semantic tokens follow the
[LSP relative token encoding](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens).

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
