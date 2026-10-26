<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from "vue";
import type { EditorController } from "./controller.ts";
import type { Edit } from "./protocol.ts";
import EditorForm from "./EditorForm.vue";

const { controller } = defineProps<{ controller: EditorController }>();
const open = ref(false);
const inspectionVersion = ref(0);
let previewDestination = "";
let timer: ReturnType<typeof setTimeout> | undefined;

function snapshot() {
  return {
    entries: [...controller.entries.values()].map((entry) => ({
      id: entry.id,
      label: `${entry.label} · ${entry.binding.definition.name}`,
    })),
    selectedId: controller.selected?.id ?? "",
    requestedState: controller.selected?.binding.requestedState,
    inspection: controller.inspection,
    draft: controller.draft,
    message: controller.message,
    stale: controller.stale,
  };
}

// Keep runtime and DOM objects out of Vue's deep reactive proxies.
const state = shallowRef(snapshot());
const unsubscribe = controller.subscribe(() => {
  const next = snapshot();

  if (next.inspection !== state.value.inspection) {
    inspectionVersion.value++;
    clearTimeout(timer);
  }

  if (
    next.selectedId !== state.value.selectedId ||
    next.requestedState !== state.value.requestedState ||
    next.stale ||
    !next.entries.some((entry) => entry.id === next.selectedId)
  ) {
    clearTimeout(timer);
  }

  state.value = next;
});

function run(operation: () => Promise<void>) {
  clearTimeout(timer);
  void operation().catch((error) => controller.report(error));
}

function select(id: string) {
  run(() => controller.select(id));
}

function toggle() {
  open.value = !open.value;

  if (!controller.selected && state.value.entries.length) {
    select(state.value.entries[0].id);
  }
}

function updateDraft(edits: Edit[], destination: string) {
  previewDestination = destination;
  controller.setDraft(edits);
  clearTimeout(timer);
  timer = setTimeout(() => run(() => controller.preview(previewDestination)), 250);
}

onScopeDispose(() => {
  clearTimeout(timer);
  unsubscribe();
});
</script>

<template>
  <section v-show="open" class="panel" aria-label="Liva motion editor">
    <div class="top">
      <h2>Motion editor</h2>
      <button @click="open = false">Close</button>
    </div>
    <p>Preview one instance. Save the shared definition.</p>
    <select
      :value="state.selectedId"
      aria-label="Preview instance"
      @change="select(($event.target as HTMLSelectElement).value)"
    >
      <option value="">Choose an instance…</option>
      <option v-for="entry in state.entries" :key="entry.id" :value="entry.id">
        {{ entry.label }}
      </option>
    </select>
    <EditorForm
      v-if="state.inspection"
      :key="inspectionVersion"
      :inspection="state.inspection"
      :draft="state.draft"
      :requested-state="state.requestedState"
      @draft="updateDraft"
      @destination="previewDestination = $event"
      @preview="(destination) => run(() => controller.preview(destination))"
      @cancel="run(() => controller.cancel())"
      @save="run(() => controller.commit())"
    />
    <div class="status" role="status">{{ state.message }}</div>
  </section>
  <button class="launcher" @click="toggle">Motion editor</button>
</template>
