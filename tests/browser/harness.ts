import * as runtime from "../../packages/runtime/src/index.ts";
import fixture from "../../fixtures/toggle.json";

Object.assign(window, {
  liva: runtime,
  definition: runtime.decodeBundle(JSON.stringify(fixture)).definitions[0],
  errors: [],
});
