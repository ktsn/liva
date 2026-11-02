<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import type { EditorController } from '../controller.ts'
import EditorForm from './EditorForm.ce.vue'

defineOptions({ inheritAttrs: false })

const { controller } = defineProps<{ controller: EditorController }>()
const open = ref(false)
const inspectionVersion = ref(0)
const panel = ref<HTMLElement>()
const panelHeight = ref(0)
let observer: ResizeObserver | undefined

function snapshot() {
  return {
    entries: [...controller.entries.values()].map((entry) => ({
      id: entry.id,
      label: `${entry.label} · ${entry.binding.definition.name}`,
    })),
    selectedId: controller.selected?.id ?? '',
    requestedState: controller.selected?.binding.requestedState,
    inspection: controller.inspection,
    draft: controller.draft,
    message: controller.message,
    stale: controller.stale,
    active: controller.previewActive,
  }
}

// Keep runtime and DOM objects out of Vue's deep reactive proxies.
const state = shallowRef(snapshot())
const unsubscribe = controller.subscribe(() => {
  const next = snapshot()

  if (next.inspection !== state.value.inspection) {
    inspectionVersion.value++
  }

  state.value = next
})

function run(operation: () => Promise<void>) {
  void operation().catch(
    /* v8 ignore next -- @preserve: This adapter only forwards rejections to the controller error reporting tested independently. */
    (error) => controller.report(error),
  )
}

function select(id: string) {
  run(async () => {
    await controller.select(id)
    revealInstance()
  })
}

function toggle() {
  open.value = !open.value

  if (!controller.selected && state.value.entries.length) {
    select(state.value.entries[0].id)
  }
  if (!open.value) controller.endPreview()
  else revealInstance()
}

function revealInstance() {
  void nextTick(() =>
    requestAnimationFrame(() => {
      const root = controller.selected?.binding.root
      if (!open.value || !root || !panel.value) return
      const available = window.innerHeight - panel.value.getBoundingClientRect().height
      const rect = root.getBoundingClientRect()
      if (rect.bottom > available || rect.top < 0)
        window.scrollBy(0, rect.top - Math.max(0, (available - rect.height) / 2))
    }),
  )
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    const previous = panelHeight.value
    /* v8 ignore next -- @preserve: The observer is attached after mount and disconnected before the panel ref is released. */
    panelHeight.value = panel.value?.getBoundingClientRect().height ?? 0
    if (panelHeight.value > previous) revealInstance()
  })
  /* v8 ignore else -- @preserve: The unconditional panel element is mounted before onMounted runs. */
  if (panel.value) observer.observe(panel.value)
})

onScopeDispose(() => {
  observer?.disconnect()
  controller.endPreview()
  unsubscribe()
})
</script>

<template>
  <div class="page-space" :style="{ height: `${panelHeight}px` }" aria-hidden="true" />
  <div class="editor">
    <section ref="panel" v-show="open" class="panel" aria-label="Liva motion editor">
      <div class="top">
        <h2>Motion editor</h2>
        <button @click="toggle">Close</button>
      </div>

      <select
        class="instance"
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
        :controller="controller"
        :active="state.active"
        :stale="state.stale"
      />
      <div class="status" role="status">{{ state.message }}</div>
    </section>
    <button v-if="!open" class="launcher" @click="toggle">Motion editor</button>
  </div>
</template>

<style src="../editor.css"></style>

<style scoped>
.page-space {
  pointer-events: none;
}
.editor {
  position: fixed;
  right: 0;
  left: 0;
  bottom: 0;
  z-index: 2147483646;
}

.instance {
  width: min(450px, 90vw);
  margin: 0 14px 8px;
}
.launcher {
  margin: 16px;
  float: right;
  background: #244e3a;
  color: white;
  border: 0;
  border-radius: 30px;
  padding: 12px 20px;
  box-shadow: 0 4px 24px #0002;
}
.panel {
  width: 100%;
  max-height: 82vh;
  background: #fffefa;
  border: 1px solid #cbd6c7;
  border-radius: 10px 10px 0 0;
  box-shadow: 0 12px 60px #152c3030;
  overflow: auto;
  padding: 0;
}
.top {
  padding: 10px 14px;
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
  margin-top: 0;
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
