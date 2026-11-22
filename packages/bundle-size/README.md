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

`OUTPUT/result.json` records the source commits, measurement conditions and all
six production builds. Each revision's `bytes` and `bundle` fields describe
the Core build. Its `features` object contains the other five builds.

| Feature          | Fixture                                                               |
| ---------------- | --------------------------------------------------------------------- |
| Core             | A minimal tween-only Button.                                          |
| Spring           | Button with spring playback.                                          |
| Controller       | Button with a `link` attachment and controller execution.             |
| Measure + Layout | Button using `measure` and layout projection together.                |
| Presence         | Button with enter and leave transitions.                              |
| Full             | Button using the named full Vue factory for programmatic definitions. |

Each case builds separately with the same settings and with Vue external.
Each revision's output directory contains the tween bundle and one subdirectory
per feature case, with its fixture, JavaScript bundle and rendered module list.
Feature byte counts describe complete bundles and include shared dependencies.

- Minified, gzip and Brotli bytes describe the complete JavaScript bundle.
- Definition JSON bytes report the UTF-8 size of the embedded definitions. They are already included in the bundle totals and cannot be subtracted from compressed sizes.

Compare saved results only when their measurement conditions match.

## PR reports

PR measurements update one comment with a row for each build and columns for
minified, gzip and Brotli sizes. Each cell shows the base and PR sizes in KB
(1 KB = 1,000 bytes) and the percentage change from base. The workflow artifact
stores exact byte counts in `result.json` and is retained for 14 days. Size
changes are informational. Measurement failures fail CI.

Measurements run on PR creation, reopening, pushes and base retargeting, including drafts and forks. Forks may require approval, and conflicted PRs wait until conflicts are resolved.
