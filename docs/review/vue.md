# Vue integration review checks

Apply these checks to changes affecting `packages/vue` or the Vue behavior of generated code.

- **Lifecycle ownership.** Verify that Vue owns structural changes and Liva owns animation execution and completion. Check that the animated targets are associated with the element whose removal or hiding must wait.
- **Presence behavior.** Exercise the affected paths through `v-if`, `v-show`, keyed `v-for`, and existing `Transition` or `TransitionGroup` boundaries. Check completion for multiple targets, reappearance during leave, and parent unmount. Verify that stale completions cannot remove or hide an element that has become active again.
- **Directive bindings.** Check that regular directives and the Vite-generated path agree on values, keys, registration, updates, and cleanup.
