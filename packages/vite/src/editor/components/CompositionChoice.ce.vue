<script setup lang="ts">
import type { Composition, Layer } from '@liva/runtime'

const props = defineProps<{
  layers: readonly Layer[]
  value: Composition
  label: string
  compare?: Composition
}>()
const emit = defineEmits<{ change: [composition: Composition] }>()

function active(name: string, enabled: boolean) {
  emit('change', {
    layers: { ...props.value.layers, [name]: enabled },
    states: { ...props.value.states },
  })
}

function state(name: string, selected: string) {
  emit('change', {
    layers: { ...props.value.layers },
    states: { ...props.value.states, [name]: selected },
  })
}

function different(name: string) {
  return (
    !!props.compare &&
    (props.value.states[name] !== props.compare.states[name] ||
      props.value.layers[name] !== props.compare.layers[name])
  )
}
</script>

<template>
  <fieldset class="composition-side">
    <legend>{{ label }}</legend>
    <div
      v-for="layer in layers"
      :key="layer.name"
      class="composition-layer"
      :class="{
        inactive: !layer.states?.length && !value.layers[layer.name],
        different: different(layer.name),
      }"
    >
      <label v-if="layer.states?.length" class="composition-control">
        {{ layer.name }}
        <select
          class="composition-state"
          :aria-label="`${label} ${layer.name} state`"
          :value="value.states[layer.name]"
          @change="state(layer.name, ($event.target as HTMLSelectElement).value)"
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
          :aria-label="`${label} ${layer.name} enabled`"
          :checked="value.layers[layer.name]"
          @change="active(layer.name, ($event.target as HTMLInputElement).checked)"
        />
        {{ layer.name }}
      </label>
      <span v-if="different(layer.name)" class="composition-difference">Different</span>
    </div>
  </fieldset>
</template>

<style scoped>
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
.composition-difference {
  font-size: 11px;
  color: var(--liva-accent);
}
</style>
