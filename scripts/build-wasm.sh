#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build --locked --release -p liva_wasm --target wasm32-unknown-unknown
wasm-bindgen --target nodejs --out-dir packages/vite/wasm target/wasm32-unknown-unknown/release/liva_wasm.wasm
printf '%s\n' '{"type":"commonjs"}' > packages/vite/wasm/package.json
