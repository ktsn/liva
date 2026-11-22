# Runtime review checks

Apply these checks to changes affecting `packages/runtime`.

- **State and resource lifetime.** Trace transition resolution, state commits, DOM application, and completion notifications. Check interruption, reversal, reinsertion, and disposal for stale completion callbacks and unreleased subscriptions or animations. Verify that a transition starting mid-animation uses the current displayed values where the contract requires it.
- **DOM layout.** Check for reads such as `getBoundingClientRect()` after DOM writes that can force synchronous layout. Look for repeated measurements of the same element within a frame. Check whether grouping reads and writes or reusing measurements preserves the required freshness.
- **Frame scheduling.** Check whether each `requestAnimationFrame` callback is needed, whether multiple callers schedule the same work, and whether callbacks stop when work settles or the owner is disposed. Consider idle cost and how scheduling scales with active instances.
- **Repeated work.** Check per-frame, per-event, and per-instance paths for full scans, nested searches, sorts, and repeated computation. Identify how the cost grows with elements, targets, or instances, and whether the work can happen on change or be shared.
- **Verification.** Test transition selection and commit order through the runtime boundary. Use real browsers to verify interpolation, interruption, and layout effects. When inspection cannot establish a performance impact, identify the interaction and scale to measure.
