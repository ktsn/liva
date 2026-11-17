# Production bundle size

Measure the JavaScript shipped by one button that toggles a boolean and animates opacity. This includes the Vue adapter, core runtime, production plugin bootstrap, generated definition loader, Vue render code and embedded definitions. Vue is an external ES module; compiler/WASM, editor code and source maps are excluded. The production output is exercised in Chromium with Vue served separately: initial opacity 0.5, toggle to 1, toggle back to 0.5, animation completion and no runtime errors.

## Reproduce

Use Node **26.13.1**, pnpm **12.21.0**, the repository's Rust toolchain, a C toolchain, Python 3 and Chromium. Install dependencies and the browser once in the checkout containing this harness:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm size:measure 99138c83be315420cf29b17accf6d2911e2027c0 bundle-size-results/baseline
pnpm size:compare origin/main HEAD bundle-size-results/comparison
```

Fetch the desired remote refs before a local comparison. Both arguments are resolved to full commit SHAs at command start. `compare` measures the two commits every time, including identical arguments. It does not use the initial baseline or cached measurement results.

The harness exports each revision into a disposable directory, installs its frozen lockfile and builds its own WASM compiler. It runs the common fixture and configuration from the invoking checkout outside both exported trees. Each measurement runs in a fresh process to isolate revision-specific compiler, native tooling and browser-client globals. Neither revision needs to contain these tools. Tracked files in the checkout are untouched. Run from a clean harness checkout when reproducing a published comparison; commit any intended harness changes first. Dependency and compiler build caches may speed installation, but builds and browser validation still run on both sides. The matching `wasm-bindgen-cli` is installed when unavailable. Unsupported compiler/plugin generation paths, dependency installation, extraction or playback failures fail measurement; they never become zero-byte measurements.

Each output directory contains `result.json`, the actual `base/bundle.js` and `head/bundle.js`, module inspection lists and playback screenshots. `measure` records its sole revision in both result sides to keep the result schema identical. Local output is ignored by Git. CI retains only the result JSON for **14 days**; logs and SHAs are linked from the PR comment.

## Metrics and conditions

Specification **1** builds normal production client output as one minified ES module targeting `es2023`, using OXC, with source maps disabled. It compresses those exact UTF-8 JavaScript bytes with gzip level 9 and Brotli quality 11. The minified output is not library mode, which can preserve whitespace in ES libraries.

`definitions` is the UTF-8 byte count of the decoded JSON string passed to `decodeBundle` by the actual production loader. It is not the escaped JavaScript string literal's length. It remains embedded in the measured JavaScript. Compression is not additive: no metric subtracts definition bytes or claims to isolate runtime-only compressed size.

Results follow [schema.json](./schema.json), with strict runtime validation in [model.mjs](./model.mjs). They include full source SHAs, bundle and lockfile SHA-256 hashes, fixture and harness identifiers, Node/zlib/Brotli/OXC/Vite/Rolldown versions, resolved root build dependencies and Vue, Rust and wasm-bindgen versions, and the generated compiler WASM hash. The fixture identifier hashes the two fixture files in documented order (`Button.vue`, `main.js`); the harness identifier hashes `measure.mjs`, then `model.mjs`. Explicit specification fields identify the shared configuration. Lockfile hashes identify all transitive dependency versions; dependency changes therefore contribute to each revision's build.

Increment `settings.version` and the schema/validator's specification version whenever fixture, output, compression or other measurement conditions change. Update the documented specification and tests together. Harness hashes additionally distinguish implementation changes within a specification. Do not compare results across different conditions as an optimization delta.

## Initial baseline

[baseline.json](./baseline.json) measures pre-tooling main commit `99138c83be315420cf29b17accf6d2911e2027c0` with this common harness. It records 105,840 minified bytes, 30,854 gzip bytes, 27,604 Brotli bytes and 591 definition JSON bytes. Repeated builds produced identical bundle hashes and metrics. This is historical reference data, not the PR comparison base.

To replace it deliberately, run `pnpm size:measure FULL_SHA OUTPUT`, inspect the emitted module list and playback, and copy `OUTPUT/result.json` to `scripts/bundle-size/baseline.json`. Review the source revision and all recorded conditions with the changed baseline. Never update it automatically on PRs.

## PR reporting

[Bundle size](../../.github/workflows/bundle-size.yml) runs independently of verification on opened, reopened, synchronized and base-retargeted PRs, including drafts and forks. It pins the current base branch tip and actual PR head before installing dependencies. Private-repository fetches receive only the job's read-only token in a separate pinning process; credentials are not persisted and the install/build steps do not receive that environment variable. The build job has read-only repository permissions and no privileged secrets. Size increases are informational; measurement failures fail the job.

[Report bundle size](../../.github/workflows/bundle-size-report.yml) runs only after the measurement workflow completes. It checks out default-branch code, installs no PR dependencies, reads bounded JSON from a ZIP without extracting paths, validates all result fields, and formats the comment itself. Its token can read artifacts and update PR comments. The API's workflow/run identity, attempt, stable PR/base run title, commit association and live PR head/base data corroborate artifact context. Per-head reporting serialization queues up to 100 pending reports (`queue: max`) so late stale notifications cannot replace the newest pending report. A final check of the current PR, attempt and newest run for that PR/base prevents older events or reruns from overwriting newer results. Another PR with the same head and a different base does not supersede it.

One `github-actions[bot]` comment identified by `<!-- liva-bundle-size:v1 -->` is created or updated. It shows base/head bytes, signed delta and percentage for minified/gzip/Brotli JavaScript and definition JSON, the compared SHAs, logs and collapsed conditions. Build failures replace prior successful metrics with a failure state and the failed side/SHA. Failures before an artifact exists use trusted run/PR metadata and link setup logs. Invalid artifacts produce a failure comment and a failing reporting workflow; API/reporting failures are also rethrown.

The base is not a merge-base or synthetic merge commit. A base push does not fan out across open PRs; comments identify the exact previously measured base until another PR event occurs. Conflicted PRs are measured after conflict resolution. Fork runs requiring maintainer approval are measured after approval. This private repository also requires the repository/organization fork and Actions settings to permit the intended fork run; this change does not alter those policies. GitHub's default-branch `workflow_run` deployment requirement means the privileged listener cannot run for the first implementation PR alone.

## Verification and rollout

```sh
pnpm test:size
pnpm test:size:integration
pnpm check
```

Unit and API-double tests cover signed/unchanged deltas, UTF-8 extraction, schema rejection, comment creation/update/failure, missing artifacts, workflow/PR/run/attempt/head/base mismatches, stale/out-of-order runs, same-head PRs, ZIP limits and observable posting failures. The integration command uses disposable exported source variants to verify repeated real builds, growth/removal, a real Vize dependency/lockfile change, and build failure on each comparison side. Every successful measurement also runs production browser playback.

After these workflows reach the default branch, maintainers must still verify automatic comments on both a same-repository PR and an approved fork PR: creation, subsequent push update in the same comment, rerun ordering, retargeting and a deliberate failed measurement. Confirm the recorded base/head SHAs, 14-day artifact retention and least-privilege behavior. This deployment verification remains **unverified until performed after merge**; the implementation PR does not claim to complete it.

GitHub documents the [event and default-branch constraints](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [fork approval](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks), and the security rationale for [separating untrusted builds from privileged reporting](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/).
