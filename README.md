# Liva

Liva is a declarative animation language for interactive Web UI. Define conditional
states, transitions and lifecycle animations in a Vue `<liva>` block, drive them
with application values or drag input, and adjust motion in the running page.
Vue retains component structure, application state and business logic.

Rust compiles definitions; the browser interpolates CSS through Web Animations.
The development editor previews one instance and saves targeted source edits.
Production includes only immutable definitions, the Vue adapter and the runtime.

## Run the playground

```sh
pnpm install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.130 --locked
sh scripts/build-wasm.sh
cd playground
vp dev --host 127.0.0.1
```

Open the URL printed in the terminal to try the demos.

Open **Motion editor** to select an instance, edit its timeline and preview changes.
**Save to source** updates the component's `<liva>` block and synchronizes shared
instances through HMR, which may reload Vue state. See [the editor guide](docs/editor.md)
for controls, inheritance and save constraints.

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

## Verify and build

```sh
pnpm exec playwright install
sh scripts/verify.sh
```

See [development and verification](docs/development.md) for individual checks,
prerequisites and tooling constraints. After building WASM, build the playground with:

```sh
cd playground
vp build
vp preview --host 127.0.0.1
```

## Documentation

| Guide                                              | Contents                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| [Language](docs/language.md)                       | Syntax, semantics, Vue presence support and language limits      |
| [Timeline editor](docs/editor.md)                  | Editing, playback, inheritance and source saves                  |
| [Language Server and Zed](docs/language-server.md) | Installation, hover, diagnostics and grammar maintenance         |
| [Architecture](docs/architecture.md)               | Module map, compiler contracts, runtime and Vue integration      |
| [Editor internals](docs/editor-internals.md)       | Components, preview protocol, source planning and guarded writes |
| [Development](docs/development.md)                 | Verification commands, coverage and toolchain constraints        |
