<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, shallowRef, useTemplateRef } from 'vue'
import type { EditorController } from '../controller.ts'
import EditorForm from './EditorForm.ce.vue'
import { timelineReadOnly, readOnlyMessage } from '../capabilities.ts'

defineOptions({ inheritAttrs: false })

const { controller } = defineProps<{ controller: EditorController }>()
const open = ref(false)
const inspectionVersion = ref(0)
const panel = useTemplateRef<HTMLElement>('panel')
const panelHeight = ref(0)
let observer: ResizeObserver | undefined
let resizeFrame = 0

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

  if (next.inspection !== state.value.inspection || next.selectedId !== state.value.selectedId) {
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
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      const previous = panelHeight.value
      /* v8 ignore next -- @preserve: The observer is attached after mount; its frame is cancelled before the panel ref is released. */
      panelHeight.value = panel.value?.getBoundingClientRect().height ?? 0
      if (panelHeight.value > previous) revealInstance()
    })
  })
  /* v8 ignore else -- @preserve: The unconditional panel element is mounted before onMounted runs. */
  if (panel.value) observer.observe(panel.value)
})

onScopeDispose(() => {
  cancelAnimationFrame(resizeFrame)
  observer?.disconnect()
  controller.endPreview()
  unsubscribe()
})
</script>

<template>
  <div class="page-space" :style="{ height: `${panelHeight}px` }" aria-hidden="true" />
  <div class="editor">
    <section v-show="open" ref="panel" aria-label="Liva motion editor" class="panel">
      <div class="top">
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
        <button @click="toggle">Close</button>
      </div>
      <p
        v-if="
          state.inspection &&
          !state.inspection.definition.layers?.length &&
          timelineReadOnly(state.inspection.definition)
        "
        role="status"
      >{{
        readOnlyMessage
      }}</p>
      <EditorForm
        v-else-if="state.inspection"
        :key="inspectionVersion"
        :inspection="state.inspection"
        :controller="controller"
        :active="state.active"
        :stale="state.stale"
      />
    </section>
    <button v-if="!open" class="launcher" @click="toggle">Motion editor</button>
  </div>
</template>

<!-- Shared editor styles are isolated by the custom element's shadow root. -->
<!-- oxlint-disable-next-line vue/require-scoped-style -->
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
  width: min(450px, 70vw);
}
.launcher {
  margin: 16px;
  float: right;
  background: var(--liva-accent);
  color: var(--liva-text-invert);
  border: 0;
  border-radius: 30px;
  padding: 12px 20px;
  box-shadow: 0 4px 24px var(--liva-shadow-launcher);
}
.panel {
  width: 100%;
  max-height: 82vh;
  background: var(--liva-surface-panel);
  border: 1px solid var(--liva-border-control);
  border-radius: 10px 10px 0 0;
  box-shadow: 0 12px 60px var(--liva-shadow-panel);
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
</style>
