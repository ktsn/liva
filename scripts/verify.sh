#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
sh scripts/build-wasm.sh
node scripts/test-wasm.mjs
vp check
vp test --run
pnpm --dir playground exec vue-tsc --noEmit
pnpm exec playwright test
node scripts/test-production.mjs
