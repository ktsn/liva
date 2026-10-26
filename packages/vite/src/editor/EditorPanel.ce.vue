<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from "vue";
import type { EditorController } from "./controller.ts";
import type { Edit } from "./protocol.ts";
import EditorForm from "./EditorForm.ce.vue";

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
  <div class="editor">
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
  </div>
</template>

<style src="./editor.css"></style>

<style scoped>
.editor {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483646;
}

.launcher {
  background: #244e3a;
  color: white;
  border: 0;
  border-radius: 30px;
  padding: 12px 20px;
  box-shadow: 0 4px 24px #0002;
}
.panel {
  width: min(440px, calc(100vw - 32px));
  max-height: 82vh;
  background: #fffefa;
  border: 1px solid #cbd6c7;
  border-radius: 12px;
  box-shadow: 0 12px 60px #152c3030;
  overflow: auto;
  padding: 20px;
  margin-bottom: 10px;
}
.top {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
.status {
  white-space: pre-wrap;
  background: #edf3e8;
  padding: 10px;
  border-radius: 6px;
  margin-top: 12px;
  font-size: 11px;
}
h2 {
  font-size: 16px;
  margin: 0;
}
p {
  margin: 8px 0;
  color: #627568;
}
</style>
