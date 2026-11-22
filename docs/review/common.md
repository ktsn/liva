# Common review checks

Apply these checks to every review. Read the checklists for each affected area.

- [Compiler](compiler.md) covers syntax, compiler output, and the WASM boundary.
- [Vite plugin](vite.md) covers SFC transforms, HMR, and production bundling.
- [Runtime](runtime.md) covers state, animation execution, and performance.
- [Vue integration](vue.md) covers directive bindings and Vue lifecycle coordination.
- [Other areas](other.md) covers the motion editor, tooling, documentation, CI, and distribution.

## Checks

- **Scope.** Check that new branches, fallbacks, and supported cases serve a concrete requirement.
- **Feature removal.** Check the removed feature's implementation, callers, dedicated diagnostics, tests, and documentation. Retain compatibility paths required by the change and make their scope clear. Do not add tests solely to verify that the feature was removed. Do not add documentation stating that the removed feature is unsupported.
- **Reuse and ownership.** Look beyond the diff for equivalent rules, calculations, and transforms. Compare units and initial conditions before deciding whether to reuse them. When a change mixes state updates, notifications, and cleanup, check who owns each step and whether the change makes any existing logic redundant.
- **Tests.** Verify important transforms, shared rules, state transitions, and failure contracts through a public boundary that owns the behavior. Look for missing boundary values, operation sequences, and failure paths. Check that assertions establish behavior beyond coverage or the values supplied by mocks.
- **Findings.** Give the triggering input or operation sequence, the user-visible or contractual impact, and how the diff introduces or worsens it. State which conditions still need execution or measurement when evidence from the diff is insufficient.
