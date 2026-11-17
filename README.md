# Liva

Liva is a declarative animation language for interactive Web UI. Define conditional
layers, local states, transitions and lifecycle animations in a Vue `<liva>` block.
Vue retains component structure, application state and business logic. See the
[language specification](docs/language.md) for syntax, semantics and supported features.

## Development

Install Vite+ (`vp`), Node.js, pnpm and Rust. Versions are pinned in `.node-version`,
`package.json` and `rust-toolchain.toml`; rustup installs the required WASM target,
rustfmt and Clippy. Run from the repository root:

```sh
pnpm install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.130 --locked
sh scripts/build-wasm.sh
pnpm --dir playground dev --host 127.0.0.1
```

Open the URL printed in the terminal. Rebuild WASM after Rust compiler changes and
before dependent tests or builds. The `wasm-bindgen-cli` version must match
`crates/liva_wasm/Cargo.toml`; the generated artifact targets Node.js.

Open **Motion editor** to select an instance, edit its timeline and preview changes.
**Save to source** updates the component's `<liva>` block and synchronizes shared
instances through HMR, which may reload Vue state. Saves retain original files in
`.liva-backups/`; avoid running source formatters concurrently. The editor requires
a local loopback development server and is excluded from production builds.

Build and preview the playground:

```sh
pnpm build
cd playground
vp preview --host 127.0.0.1
```

## Vue integration

Add the Liva plugin before the Vue plugin in `vite.config.ts`:

```ts
import { defineConfig } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import liva from '@liva/vite'

export default defineConfig({ plugins: [liva(), vue()] })
```

Install the Vue plugin in the application entry:

```ts
import { createApp } from 'vue'
import liva from '@liva/vue'
import App from './App.vue'

createApp(App).use(liva).mount('#app')
```

See complete component examples in
[Toggle.vue](playground/src/Toggle.vue) and [drag.vue](playground/src/pages/drag.vue).

## Verification

```sh
pnpm exec playwright install
sh scripts/verify.sh
```

On Linux, install browser system dependencies with
`pnpm exec playwright install --with-deps`. Ports 4179–4181 must be available.
Individual checks:

| Check                             | Command                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| Rust formatting                   | `cargo fmt --all --check`                                        |
| Rust lint                         | `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| Rust tests                        | `cargo test --workspace --locked`                                |
| WASM serialization contract       | `node scripts/test-wasm.ts`                                      |
| Types, lint and formatting        | `pnpm check`                                                     |
| Unit and component tests          | `vp test --run`                                                  |
| Browser integration               | `pnpm exec playwright test`                                      |
| Production isolation and playback | `node scripts/test-production.ts`                                |

Run browser checks for interpolation, interruption and lifecycle changes; DOM mocks
cannot verify Web Animations behavior. Update `fixtures/` with serialization changes.
Use `pnpm typecheck`, `vp run lint` and `vp run fmt:check` for separate static checks,
or `vp run fmt` to format. Preserve `<liva>` block contents when formatting Vue files.
Keep the root Vize/Vite+ configuration wrapper for browser test initialization.

## Zed extension

Install [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases), then build the
language server and bundled highlighting grammar from the repository root:

```sh
rustup target add wasm32-wasip2
cargo install --path crates/liva_lsp --locked
cargo install tree-sitter-cli --version 0.26.3 --locked --root target/tools
export PATH="$PWD/target/tools/bin:$PATH"
export WASI_SDK_PATH="/absolute/path/to/wasi-sdk"
pnpm --dir editors/zed build
```

Keep `~/.cargo/bin` on Zed's PATH. Uninstall any existing Liva extension, then link
the local build into Zed's extensions directory. On macOS:

```sh
mkdir -p "$HOME/Library/Application Support/Zed/extensions/installed"
ln -s "$PWD/editors/zed" "$HOME/Library/Application Support/Zed/extensions/installed/liva"
```

On Linux, use `${XDG_DATA_HOME:-$HOME/.local/share}/zed/extensions/installed`.
Use this link workflow because **Install Dev Extension** fetches grammar sources
from Git rather than building the bundled grammar. Keep the checkout at the linked
location and restart Zed after building. Reinstall the server after server changes.

For Vue highlighting, install Zed's Vue extension and use `<liva lang="liva">`.
Enable Liva alongside Vue's other language servers in Zed settings:

```json
{
  "languages": {
    "Vue.js": { "language_servers": ["liva", "..."] }
  }
}
```

Check extension and grammar changes separately:

```sh
cargo check --manifest-path editors/zed/Cargo.toml
pnpm --dir editors/zed test:grammar
```

Rebuild after grammar changes; commit grammar sources and tests, excluding generated
parser sources and WASM artifacts.
