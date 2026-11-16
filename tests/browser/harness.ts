import {
  assembleRuntime,
  nativeEffects,
} from '../../packages/runtime/src/__test__/helpers/assembly.ts'
import { interaction } from '../../packages/runtime/src/builtins/interaction.ts'
import { drag } from '../../packages/runtime/src/builtins/drag.ts'
import * as runtime from '../../packages/runtime/src/index.ts'
import fixture from '../../fixtures/toggle.json'

Object.assign(window, {
  liva: runtime,
  assembleRuntime,
  nativeEffects,
  browserInputs: { interaction, drag },
  definition: runtime.decodeBundle(JSON.stringify(fixture)).definitions[0],
  errors: [],
})
