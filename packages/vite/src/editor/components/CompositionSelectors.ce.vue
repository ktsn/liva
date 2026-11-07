<script setup lang="ts">
import type { Composition, CompositionTransition, Layer } from '@liva/runtime'

const props = defineProps<{
  layers: readonly Layer[]
  from: Composition
  to: Composition
  transition?: CompositionTransition
}>()
const emit = defineEmits<{
  change: [side: 'from' | 'to', composition: Composition]
  swap: []
  transition: [identity: CompositionTransition | undefined]
}>()

const sides = ['from', 'to'] as const
const sideLabels = { from: 'From', to: 'To' }
const transitions = props.layers.flatMap((layer) =>
  (layer.transitions ?? []).map((transition, index) => ({
    identity: { layer: layer.name, index },
    label: `${layer.name}: ${transition.from} → ${transition.to} (declaration ${index + 1})`,
    value: JSON.stringify({ layer: layer.name, index }),
  })),
)

function active(side: 'from' | 'to', name: string, enabled: boolean) {
  emit('change', side, {
    layers: { ...props[side].layers, [name]: enabled },
    states: { ...props[side].states },
  })
}

function state(side: 'from' | 'to', name: string, selected: string) {
  emit('change', side, {
    layers: { ...props[side].layers },
    states: { ...props[side].states, [name]: selected },
  })
}

function choose(value: string) {
  emit('transition', transitions.find((item) => item.value === value)?.identity)
}
</script>

<template>
  <section aria-label="Composition selection" class="composition-selectors">
    <div class="composition-actions">
      <label class="composition-transition">Existing transition
        <select
          aria-label="Existing transition"
          class="composition-shortcut composition-action-control"
          :value="transition ? JSON.stringify(transition) : ''"
          @change="choose(($event.target as HTMLSelectElement).value)"
        >
          <option value="">No selected transition</option>
          <option v-for="item in transitions" :key="item.value" :value="item.value">{{
            item.label
          }}</option>
        </select>
      </label>
      <button class="composition-action-control" @click="emit('swap')">Swap</button>
    </div>
    <div class="composition-pair">
      <fieldset v-for="side in sides" :key="side" class="composition-side">
        <legend>{{ sideLabels[side] }}</legend>
        <div
          v-for="layer in layers"
          :key="layer.name"
          class="composition-layer"
          :class="{
            inactive: !layer.states?.length && !props[side].layers[layer.name],
            different: layer.states?.length
              ? from.states[layer.name] !== to.states[layer.name]
              : from.layers[layer.name] !== to.layers[layer.name],
          }"
        >
          <label v-if="layer.states?.length" class="composition-control">
            {{ layer.name }}
            <select
              class="composition-state"
              :aria-label="`${sideLabels[side]} ${layer.name} state`"
              :value="props[side].states[layer.name]"
              @change="state(side, layer.name, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in layer.states" :key="item.name" :value="item.name">{{
                item.name
              }}</option>
            </select>
          </label>
          <label v-else class="composition-control">
            <input
              class="composition-checkbox"
              type="checkbox"
              :aria-label="`${sideLabels[side]} ${layer.name} enabled`"
              :checked="props[side].layers[layer.name]"
              @change="active(side, layer.name, ($event.target as HTMLInputElement).checked)"
            />
            {{ layer.name }}
          </label>
          <span
            v-if="layer.states?.length
              ? from.states[layer.name] !== to.states[layer.name]
              : from.layers[layer.name] !== to.layers[layer.name]"
            class="composition-difference"
          >Different</span>
        </div>
      </fieldset>
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
.composition-side {
  min-inline-size: 0;
  border: 1px solid var(--liva-border-control);
  border-radius: 4px;
  padding: 8px;
}
.composition-layer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-block: 5px;
  padding-inline: 6px;
  &.inactive {
    opacity: .6;
  }
  &.different {
    border-inline-start: 3px solid var(--liva-accent);
  }
}
.composition-control {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.composition-checkbox {
  inline-size: auto;
  block-size: auto;
}
.composition-state {
  inline-size: 140px;
  max-inline-size: 100%;
}
.composition-transition {
  margin: 0;
}
.composition-shortcut {
  inline-size: min(420px, 100%);
}
.composition-difference {
  font-size: 11px;
  color: var(--liva-accent);
}
</style>
