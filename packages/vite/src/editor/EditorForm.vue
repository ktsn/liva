<script setup lang="ts">
import { computed, ref } from "vue";
import { resolve } from "@liva/runtime";
import type { Edit, Inspection } from "./protocol.ts";
import TimingField from "./TimingField.vue";
import FrameControls from "./FrameControls.vue";
import OverrideControls from "./OverrideControls.vue";

const props = defineProps<{ inspection: Inspection; draft: Edit[]; requestedState?: string }>();
const emit = defineEmits<{
  draft: [edits: Edit[], destination: string];
  preview: [destination: string];
  destination: [destination: string];
  cancel: [];
  save: [];
}>();
const definition = computed(() => props.inspection.definition);
const destination = ref(
  definition.value.states.find((state) => state.name !== props.requestedState)?.name ??
    definition.value.states[0].name,
);
const groups = computed(() => {
  const result = new Map<string, Inspection["fields"]>();

  for (const field of props.inspection.fields) {
    if (field.kind !== "value" || !field.path.includes("/transition/")) continue;
    const segments = field.path.split("/transition/")[1].split("/");
    const label =
      segments[0] === "general"
        ? "General · shared by all directions"
        : `${segments[1]} → ${segments[2]} · local overrides`;
    const fields = result.get(label) ?? [];
    fields.push(field);
    result.set(label, fields);
  }

  return [...result].map(([label, fields]) => ({ label, fields }));
});
const inheritance = computed(() => {
  const from = props.requestedState ?? definition.value.states[0].name;

  try {
    const tracks = resolve(definition.value, from, destination.value);
    const direction = definition.value.directionalTransitions.find(
      (item) => item.from === from && item.to === destination.value,
    )?.transition;

    return tracks
      .map((track) => {
        const local = direction?.targets
          .find((target) => target.name === track.target)
          ?.properties.find((property) => property.name === track.property);
        const general = definition.value.generalTransition?.targets
          .find((target) => target.name === track.target)
          ?.properties.find((property) => property.name === track.property);
        const origin = local?.timing
          ? "local property"
          : general?.timing
            ? "inherited general property"
            : direction?.timing
              ? "local transition"
              : "inherited general transition";
        const frames = local?.keyframes
          ? " · local frames"
          : general?.keyframes
            ? " · inherited frames"
            : "";
        return `${track.target}.${track.property} · ${track.timing.kind}\n  ${origin}${frames}`;
      })
      .join("\n");
  } catch (error) {
    return String(error);
  }
});

function add(edit: Edit, existing = props.draft) {
  const edits = [...existing, edit];
  // Frame value edits resolve their old identity before an offset edit moves it.
  edits.sort(
    (a, b) =>
      Number(a.op === "set" && a.path.endsWith("/offset")) -
      Number(b.op === "set" && b.path.endsWith("/offset")),
  );
  emit("draft", edits, destination.value);
}

function change(path: string, value: string) {
  const timingPath = path.includes("/timing/")
    ? path.slice(0, path.indexOf("/timing/") + 7)
    : undefined;
  const edits = props.draft.filter(
    (edit) =>
      edit.op !== "set" ||
      (edit.path !== path &&
        !(path.endsWith("/timing") && edit.path.startsWith(`${path}/`)) &&
        edit.path !== timingPath),
  );
  add({ op: "set", path, value }, edits);
}

function remove(path: string) {
  add(
    { op: "removeFrame", path },
    props.draft.filter((edit) => edit.op !== "set" || !edit.path.startsWith(`${path}/`)),
  );
}

function disabled(path: string) {
  return props.draft.some(
    (edit) =>
      (edit.op === "removeFrame" || (edit.op === "set" && edit.path.endsWith("/timing"))) &&
      path.startsWith(`${edit.path}/`),
  );
}
</script>

<template>
  <label
    >Preview destination
    <select
      v-model="destination"
      aria-label="Preview destination"
      @change="emit('destination', destination)"
    >
      <option v-for="state in definition.states" :key="state.name" :value="state.name">
        {{ state.name }}
      </option>
    </select>
  </label>
  <pre class="origin">{{ inheritance }}</pre>
  <details>
    <summary>States</summary>
    <pre>{{ JSON.stringify(definition.states, null, 2) }}</pre>
  </details>
  <details v-for="group in groups" :key="group.label" open>
    <summary>{{ group.label }}</summary>
    <TimingField
      v-for="field in group.fields"
      :key="field.path"
      :field="field"
      :disabled="disabled(field.path)"
      @change="(value) => change(field.path, value)"
    />
  </details>
  <FrameControls :inspection="inspection" :draft="draft" @add="add" @remove="remove" />
  <OverrideControls :definition="definition" @add="add" />
  <div class="actions">
    <button @click="emit('preview', destination)">Preview</button>
    <button @click="emit('cancel')">Cancel draft</button>
    <button @click="emit('save')">Save to source</button>
  </div>
</template>
