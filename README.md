# Liva

Liva is a declarative animation language for interactive Web UI. Write states and
transitions in a Vue `<liva>` block, drive them with Vue state, and adjust motion in
the running application. Rust compiles definitions; the browser interpolates CSS
through Web Animations. The in-page editor is available only during development.

The MVP includes tweens, duration/bounce and physical springs, intermediate frames,
directional overrides, interruption, independent instances, reduced motion,
instance-local previews, and format-preserving source saves.

## Run the playground

Use Node **24.22.1**, pnpm **12.4.2**, Rust **1.97.1**, and the global Vite+ launcher
**1.1.0**. The workspace pins Vite+ **1.4.0** and all package dependencies. Install
Rust with rustup; `rust-toolchain.toml` selects its components and WASM target.
Install the global launcher using the [Vite+ installation guide](https://viteplus.dev/guide/global-cli)
with `VP_VERSION=1.1.0`.

```sh
pnpm install --frozen-lockfile
cargo install wasm-bindgen-cli --version 0.2.127 --locked
sh scripts/build-wasm.sh
cd playground
vp dev --host 127.0.0.1
```

Open the URL printed by Vite+. The **Notifications** and **Product updates** switches
share one definition but have independent Vue and animation state. Click or use
Space/Enter; reverse a switch before its motion finishes. The separate beacon
illustrates a second definition.

Open **Motion editor** to show the docked timeline. Choose an instance and a
transition, then expand a target to reveal its CSS property tracks. Double-click
a property lane to add a keyframe, enter its value, and apply it in the inspector.
Drag keys to change their positions or drag the duration handle to stretch a track
while preserving its keyframe percentages. Hold Alt to disable snapping.

Drag the playhead to scrub the selected instance, or use **Play** / **Pause**.
**End preview** and closing the dock restore the latest application state while
retaining the draft. **Discard changes** reloads the source. **Save to source**
updates the component's `<liva>` block and waits for shared instances to synchronize
through HMR. Vue may reload component state on HMR.

The inspector edits tween and spring parameters, keyframe values/easing, and
state-derived endpoints. Directional edits copy inherited keyframes automatically;
timing and frame overrides can return to common settings independently. Property
blocks containing comments require direct source editing to preserve placement.
See the [timeline editor guide](docs/editor.md) for inheritance, playback, and scope.

A save rejects stale revisions, invalid input, and paths outside the Vite project
root. Failed saves retain the draft. After an external edit, cancel to reload its
revision before editing again. Recovery copies live in the ignored
`playground/.liva-backups/` directory, keyed by the original full-file SHA-256.
The bridge supports local HTTP sessions; remote/proxied editing is outside the MVP.

## Vue integration

With the Liva Vite plugin configured, install the Vue plugin through its package:

```ts
import { createApp } from 'vue'
import liva from '@liva/vue'
import App from './App.vue'

createApp(App).use(liva).mount('#app')
```

The Vite plugin resolves this package entry to the development integration while
serving, and to the runtime-only plugin while building. Application code and its
types use ordinary package exports; no virtual-module declaration is needed.
Without Vite interception, the package's default export is also runtime-only.
For explicit plugin construction without the editor, import `createLivaPlugin`
from `@liva/vue/runtime` and pass it the diagnostic/observation options you need.

## Verify and build

```sh
pnpm exec playwright install
sh scripts/verify.sh
```

The verification script runs Rust formatting, Clippy and tests; rebuilds WASM;
checks the Node/TypeScript contract; runs TypeScript and Vue checks, unit and
three-browser tests; then checks actual production playback and editor exclusion
in both normal and `development`-named build modes. Ports **4179–4181** must be free
for a clean run. On Linux, use `pnpm exec playwright install --with-deps` to install
browser system dependencies. CI runs the same script.

To build just the app after building WASM:

```sh
cd playground
vp build
vp preview --host 127.0.0.1
```

The production bundle includes Vue, the runtime, and immutable definitions. It
contains no editor, compiler WASM, source mappings, or source-writing endpoint.

## Repository

| Path                   | Responsibility                                    |
| ---------------------- | ------------------------------------------------- |
| `crates/liva_syntax`   | Lossless Rowan CST, lexer, recovery, AST views    |
| `crates/liva_compiler` | Validation, Definition IR, source edit planning   |
| `crates/liva_wasm`     | Node WASM JSON boundary                           |
| `packages/runtime`     | Resolution, scalar springs, WAAPI lifecycle       |
| `packages/vue`         | Component definitions and directives              |
| `packages/vite`        | Custom-block compilation, HMR, development editor |
| `playground`           | Normal Vue application and integration fixtures   |

The editor lives in `packages/vite/src/editor/`:

- `components/` contains the Vue SFCs: the panel, edit form, and individual controls.
- `communication/` contains the shared protocol, HTTP client, HMR event subscriptions,
  and server-side source transactions with their tests.
- The editor root contains `controller.ts` for state and edit coordination,
  `timeline.ts` for track resolution and coordinates, `client.ts` for development-plugin
  setup, `ui.ts` for mounting, and `editor.css`
  for shared base styles.

Component-specific rules live in each SFC's `<style scoped>`. The `.ce.vue`
convention lets Vue inject component styles into the editor's shadow root.
The verification script type-checks the editor templates separately from the
playground and formats editor SFCs without reformatting playground `<liva>` blocks.

Read the [language specification](docs/language.md), [architecture](docs/architecture.md),
[MVP acceptance plan](docs/mvp.md), and [validation record](docs/validation.md).
The validation record describes tested browser versions, tolerances, source-save
constraints, and implementation decisions. Standalone `.liv` imports, other framework
adapters, implicit DOM state values, and spring velocity preservation are outside
the MVP.
