# Vite plugin review checks

Apply these checks to SFC transformation, HMR, and production bundling in `packages/vite`. For editor behavior, see [Other review checks](other.md).

- **SFC transformation.** Check whether the existing Vue/Vize parse results can supply the required information. Verify that Presence transforms preserve relevant template structure, keys, and directive values. Check generated names against user-defined names.
- **Hot updates.** Verify that template-only edits reach HMR and that generated references, Vue state, and leave behavior still agree after the update.
- **Production output.** Verify that the build includes the runtime features the compiled motions use and resolves a single runtime instance, including with symlinks preserved when relevant. Check that editor and source-writing code stays out of production output.
