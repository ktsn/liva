# Bundle size

Measure runtime JavaScript size with minimal Liva code.

## Measure one revision

`size:measure` builds one committed revision and saves its measurements. Run it from the repository root:

```sh
pnpm size:measure HEAD bundle-size-results/current
```

## Compare revisions

`size:compare` measures two committed revisions and reports their sizes side by side. Fetch remote refs before comparing:

```sh
git fetch origin main
pnpm size:compare origin/main HEAD bundle-size-results/comparison
```

## Read the results

`OUTPUT/result.json` records sizes, source commits and measurement conditions. The output directory also contains the measured JavaScript.

- Minified, gzip and Brotli bytes describe the complete JavaScript bundle.
- Definition JSON bytes report the UTF-8 size of the embedded definitions. They are already included in the bundle totals and cannot be subtracted from compressed sizes.

Compare saved results only when their measurement conditions match.

## PR reports

PR measurements update one comment with base/head sizes, deltas, commit SHAs and workflow logs. Size increases are informational; measurement failures fail CI. Result artifacts are retained for 14 days.

Measurements run on PR creation, reopening, pushes and base retargeting, including drafts and forks. Forks may require approval, and conflicted PRs wait until conflicts are resolved.

Automatic comments require the reporting workflow on the default branch. Same-repository and fork comment creation and updates still need verification after deployment.
