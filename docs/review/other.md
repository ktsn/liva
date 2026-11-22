# Other review checks

Apply the relevant checks when a change affects the following areas.

- **Motion editor.** Verify that ending a preview restores the prior presentation. Check that users can see why a save was rejected and retry after correcting the input. Review source changes during editing and confirm that protected content and intervening edits are preserved.
- **LSP, editor integration, and documentation.** Check that affected diagnostics, hover information, highlighting, specification, and examples agree. For diagnostic range changes, verify the range in the editor with UTF-8, CRLF, and incomplete input as relevant.
- **CI, distribution, and bundle size.** Verify the affected contract through the standard root commands. Check that a failed or skipped required job cannot produce a successful CI Gate. For packaging changes, check source-based development and distributed JavaScript and type resolution. For bundle comparisons, check that base and head use the same build and measurement conditions.
