<script setup lang="ts">
import { computed, ref } from "vue";
import type { Inspection } from "../communication/protocol.ts";

const props = defineProps<{ field: Inspection["fields"][number]; disabled: boolean }>();
const emit = defineEmits<{ change: [value: string] }>();
const value = ref(props.field.value);
const fullTiming = computed(() => props.field.path.endsWith("/timing"));
const label = computed(() =>
  props.field.path
    .split("/transition/")[1]
    .replace(/^general\//, "")
    .replace(/^directional\/[^/]+\/[^/]+\//, "")
    .replace(/target\/|property\//g, "")
    .replaceAll("/", " · "),
);
const milliseconds = computed(
  () => parseFloat(value.value) * (value.value.endsWith("ms") ? 1 : 1000),
);

function slide(event: Event) {
  value.value = (event.target as HTMLInputElement).value + "ms";
  emit("change", value.value);
}
</script>

<template>
  <div class="field">
    <label>
      {{ fullTiming ? `${label} (expression / change mode)` : label }}
      <textarea
        v-if="fullTiming"
        v-model="value"
        :data-path="field.path"
        :disabled="disabled"
        @change="emit('change', value)"
      />
      <input
        v-else
        v-model="value"
        :data-path="field.path"
        :disabled="disabled"
        @change="emit('change', value)"
      />
    </label>
    <input
      v-if="field.path.endsWith('/timing/duration')"
      type="range"
      min="1"
      max="2000"
      step="1"
      :value="milliseconds"
      :data-path="field.path"
      :disabled="disabled"
      :aria-label="label + ' slider'"
      @input="slide"
    />
  </div>
</template>

<style scoped>
.field {
  border-left: 2px solid #d4dfca;
  padding-left: 10px;
}
</style>
