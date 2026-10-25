import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {
    ignorePatterns: [
      "**/*.vue",
      "fixtures/**",
      "docs/**",
      "AGENTS.local.md",
      "packages/vite/wasm/**",
      "Cargo.lock",
    ],
  },
  test: { include: ["packages/**/*.test.ts"], exclude: ["**/node_modules/**"] },
});
