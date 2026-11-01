# Development and verification

Follow [README.md](../README.md) to install dependencies and run the playground.
Toolchain versions are pinned in `.node-version`, `rust-toolchain.toml`, package
manifests and lockfiles. Vite+ provides JavaScript/TypeScript development tooling;
pnpm and Cargo manage the workspaces.

## Verification

From the repository root:

```sh
pnpm exec playwright install
sh scripts/verify.sh
```

On Linux, use `pnpm exec playwright install --with-deps`. Ports 4179–4181 must be
available. The same verification entrypoint runs in GitHub Actions.

| Check                             | Command                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Rust formatting                   | `cargo fmt --all --check`                                                              |
| Rust lint                         | `cargo clippy --workspace --all-targets --locked -- -D warnings`                       |
| Rust tests                        | `cargo test --workspace --locked`                                                      |
| Build compiler WASM               | `sh scripts/build-wasm.sh`                                                             |
| Rust/JSON/TypeScript contract     | `node scripts/test-wasm.ts`                                                            |
| JS/TS formatting, lint and types  | `vp check`                                                                             |
| Unit tests                        | `vp test --run`                                                                        |
| Playground Vue types              | `pnpm --dir playground exec vue-tsc --noEmit`                                          |
| Editor Vue types                  | `pnpm --dir playground exec vue-tsc --noEmit -p ../packages/vite/tsconfig.editor.json` |
| Browser integration               | `pnpm exec playwright test`                                                            |
| Production playback and isolation | `node scripts/test-production.ts`                                                      |

Rebuild WASM before dependent tests or builds. `wasm-bindgen-cli` must match the
Rust dependency version; the artifact targets Node, not the browser. See
[wasm-bindgen Node deployment](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html).
Zed extension and grammar checks are separate; see [language-server.md](language-server.md).

## What to verify

- Syntax tests preserve bytes, comments, Unicode ranges and malformed-input recovery.
  Compiler tests cover diagnostics, inference, timing normalization and source edits.
- Fixtures under `fixtures/` connect Rust serialization, the actual Node WASM
  artifact and the immutable TypeScript schema. Update them together when IR changes.
- Unit tests cover pure resolution, spring sampling, reactive evaluation and editor
  transactions. DOM mocks cannot establish CSS interpolation or interruption behavior.
- Playwright runs Chromium, Firefox and WebKit for real WAAPI behavior, lifecycle
  cleanup, Vue integration and previews. Shared-file-writing scenarios run only in
  Chromium to avoid concurrent writes; other engines skip those duplicate scenarios.
- Production checks build both normal and `development` modes, scan for editor,
  compiler, source-map and WASM artifacts, and exercise playback and POST rejection.
  `FORCE_COLOR=1 CI=1 node scripts/test-production.ts` also checks colored server output.

Browser coverage follows the pinned Playwright binaries. Older browser versions
have no compatibility guarantee. Tests use controlled WAAPI times; reversal
comparisons allow 0.03 for transform components and 1.1 for serialized color
channels, and spring translation comparisons allow 0.1 px.

## Tooling constraints

TypeScript 5.9.3 supports the legacy `lib/tsc` API used by the pinned Vue checker.
The Vue checks cover SFCs and application/test sources; `vp check` checks Vite
configuration separately because including it in the Vue checker triggers a
compiler assertion in overloaded plugin signatures. Verify both paths when updating
the tooling.

Vite+ bundles Vite and Vitest. pnpm can report Vitest's Vite peer range against the
wrapper package version rather than its bundled Vite version. Check bundled versions
and integration tests when upgrading instead of adding independent Vite/Vitest copies.

Formatting uses single quotes and no semicolons. Preserve custom `<liva>` block
contents when changing Vue formatting. The runtime browser harness scans only its
own HTML entry so it does not resolve playground editor modules without the plugin.
