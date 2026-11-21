import type { RuntimeValue } from './reactive-value.ts'

export const linear = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'linear',
}) satisfies RuntimeValue
export const ease = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'ease',
}) satisfies RuntimeValue
export const easeIn = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'ease-in',
}) satisfies RuntimeValue
export const easeOut = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'ease-out',
}) satisfies RuntimeValue
export const easeInOut = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'ease-in-out',
}) satisfies RuntimeValue
export const stepStart = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'step-start',
}) satisfies RuntimeValue
export const stepEnd = /* @__PURE__ */ Object.freeze({
  kind: 'easing',
  css: 'step-end',
}) satisfies RuntimeValue
export const instant = /* @__PURE__ */ Object.freeze({
  kind: 'tween',
  durationMs: 0,
  easing: 'linear',
}) satisfies RuntimeValue
