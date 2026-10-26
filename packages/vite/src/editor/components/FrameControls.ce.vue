<script setup lang="ts">
import { computed, ref } from "vue";
import type { Edit, Inspection } from "../communication/protocol.ts";

const props = defineProps<{ inspection: Inspection; draft: Edit[] }>();
const emit = defineEmits<{ add: [edit: Edit]; remove: [path: string] }>();
const tracks = computed(() =>
  props.inspection.fields.filter(
    (field) =>
      field.kind === "block" &&
      field.path.includes("/property/") &&
      !field.path.includes("/frame/"),
  ),
);
const frames = computed(() =>
  props.inspection.fields.filter(
    (field) => field.kind === "block" && /\/frame\/[^/]+$/.test(field.path),
  ),
);
const track = ref(tracks.value[0]?.path ?? "");
const offset = ref("50");
const value = ref("1.1");
const easing = ref("");

function add() {
  emit("add", {
    op: "addFrame",
    path: track.value,
    offset: Number(offset.value) / 100,
    value: value.value,
    ...(easing.value ? { easing: easing.value } : {}),
  });
}

function removed(path: string) {
  return props.draft.some((edit) => edit.op === "removeFrame" && edit.path === path);
}
</script>

<template>
  <details>
    <summary>Add or remove a keyframe</summary>
    <select v-model="track" aria-label="Frame track">
      <option v-for="item in tracks" :key="item.path" :value="item.path">
        {{
          item.path.replace(`${inspection.definition.name}/transition/`, "").replaceAll("/", " · ")
        }}
      </option>
    </select>
    <label>New frame offset (%)<input v-model="offset" /></label>
    <label>New frame value<input v-model="value" /></label>
    <label>New frame easing (optional)<input v-model="easing" /></label>
    <button :disabled="!track" @click="add">Add frame to draft</button>
    <button
      v-for="frame in frames"
      :key="frame.path"
      :title="frame.path"
      :disabled="removed(frame.path)"
      @click="emit('remove', frame.path)"
    >
      Remove {{ frame.path.split("/frame/")[1] }} frame
    </button>
  </details>
</template>
