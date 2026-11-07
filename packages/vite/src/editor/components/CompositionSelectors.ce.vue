<script setup lang="ts">
import CompositionChoice from './CompositionChoice.ce.vue'
import type { Composition, CompositionTransition, Layer } from '@liva/runtime'

const props = defineProps<{
  layers: readonly Layer[]
  from: Composition
  to: Composition
  phase?: 'enter' | 'leave'
  transition?: CompositionTransition
}>()
const emit = defineEmits<{
  phase: [value: 'enter' | 'leave']
  change: [side: 'from' | 'to', composition: Composition]
  swap: []
  transition: [identity: CompositionTransition | undefined]
}>()

const sides = ['from', 'to'] as const
const sideLabels = { from: 'From', to: 'To' }
const transitions = props.layers.flatMap((layer) =>
  (layer.transitions ?? []).map((transition, index) => ({
    identity: { layer: layer.name, index },
    label: `${layer.name}: ${transition.from} → ${transition.to}`,
    value: JSON.stringify({ layer: layer.name, index }),
  })),
)

function choose(value: string) {
  if (value === 'enter-default' || value === 'leave-default')
    emit('phase', value === 'enter-default' ? 'enter' : 'leave')
  else emit('transition', transitions.find((item) => item.value === value)?.identity)
}
</script>

<template>
  <section aria-label="Composition selection" class="composition-selectors">
    <div class="composition-actions">
      <label class="composition-transition">Existing transition
        <select
          aria-label="Existing transition"
          class="composition-shortcut composition-action-control"
          :value="phase ? `${phase}-default` : transition ? JSON.stringify(transition) : ''"
          @change="choose(($event.target as HTMLSelectElement).value)"
        >
          <option value="">No selected transition</option>
          <option value="enter-default">Enter</option>
          <option value="leave-default">Leave</option>
          <option v-for="item in transitions" :key="item.value" :value="item.value">{{
            item.label
          }}</option>
        </select>
      </label>
      <button v-if="!phase" class="composition-action-control" @click="emit('swap')">Swap</button>
    </div>
    <CompositionChoice
      v-if="phase"
      :layers="layers"
      :value="to"
      label="Baseline"
      @change="emit('change', 'to', $event)"
    />
    <div v-else class="composition-pair">
      <CompositionChoice
        v-for="side in sides"
        :key="side"
        :layers="layers"
        :label="sideLabels[side]"
        :value="props[side]"
        :compare="props[side === 'from' ? 'to' : 'from']"
        @change="emit('change', side, $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.composition-selectors {
  padding-block: 8px;
  padding-inline: 14px;
}
.composition-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  margin-block-end: 8px;
}
.composition-action-control {
  block-size: 34px;
}
.composition-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.composition-transition {
  margin: 0;
}
.composition-shortcut {
  inline-size: min(420px, 100%);
}
</style>
