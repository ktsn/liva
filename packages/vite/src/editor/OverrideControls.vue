<script setup lang="ts">
import { computed, ref } from "vue";
import type { Definition } from "@liva/runtime";
import type { Edit } from "./protocol.ts";

const props = defineProps<{ definition: Definition }>();
const emit = defineEmits<{ add: [edit: Edit] }>();
const states = computed(() => props.definition.states);
const pairs = computed(() =>
  states.value[0].targets.flatMap((target) =>
    target.properties.map((property) => ({
      value: `${target.name}/${property.name}`,
      label: `${target.name}.${property.name}`,
    })),
  ),
);
const from = ref(states.value[0].name);
const to = ref(states.value[1]?.name ?? from.value);
const property = ref(pairs.value[0]?.value ?? "");
const timing = ref("tween(duration: 350ms, easing: ease-out)");

function add() {
  const [target, name] = property.value.split("/");
  emit("add", {
    op: "override",
    definition: props.definition.name,
    from: from.value,
    to: to.value,
    target,
    property: name,
    timing: timing.value,
  });
}
</script>

<template>
  <details>
    <summary>Create a directional timing override</summary>
    <label
      >From
      <select v-model="from" aria-label="Override from state">
        <option v-for="state in states" :key="state.name" :value="state.name">
          {{ state.name }}
        </option>
      </select>
    </label>
    <label
      >To
      <select v-model="to" aria-label="Override to state">
        <option v-for="state in states" :key="state.name" :value="state.name">
          {{ state.name }}
        </option>
      </select>
    </label>
    <label
      >Property
      <select v-model="property" aria-label="Override property">
        <option v-for="pair in pairs" :key="pair.value" :value="pair.value">
          {{ pair.label }}
        </option>
      </select>
    </label>
    <label>Override timing<textarea v-model="timing" /></label>
    <button :disabled="!property" @click="add">Add override to draft</button>
  </details>
</template>
