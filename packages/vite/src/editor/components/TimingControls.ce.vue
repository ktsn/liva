<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Timing } from '@liva/runtime'

const props = withDefaults(defineProps<{ timing?: Timing; actionLabel?: string }>(), {
  actionLabel: 'Apply timing',
})
const emit = defineEmits<{ apply: [timing: Timing] }>()
const kind = ref<Timing['kind']>('tween')
const duration = ref(350)
const bounce = ref(0.25)
const stiffness = ref(300)
const damping = ref(20)
const mass = ref(1)
const defaultEasing = ref('linear')

watch(
  () => props.timing,
  () => {
    const timing = props.timing
    kind.value = timing?.kind ?? 'tween'
    duration.value = timing && timing.kind !== 'spring-physics' ? timing.durationMs : 350
    if (timing?.kind === 'tween') defaultEasing.value = timing.easing
    if (timing?.kind === 'spring-duration') bounce.value = timing.bounce
    if (timing?.kind === 'spring-physics') {
      stiffness.value = timing.stiffness
      damping.value = timing.damping
      mass.value = timing.mass
    }
  },
  { immediate: true },
)

function applyTiming() {
  const timing: Timing =
    kind.value === 'tween'
      ? { kind: 'tween', durationMs: duration.value, easing: defaultEasing.value }
      : kind.value === 'spring-duration'
        ? { kind: 'spring-duration', durationMs: duration.value, bounce: bounce.value }
        : {
            kind: 'spring-physics',
            stiffness: stiffness.value,
            damping: damping.value,
            mass: mass.value,
          }
  emit('apply', timing)
}
</script>

<template>
  <label>Timing<select v-model="kind" aria-label="Timing mode">
      <option value="tween">Tween</option>
      <option value="spring-duration">Duration spring</option>
      <option value="spring-physics">Physics spring</option>
    </select></label>
  <label v-if="kind !== 'spring-physics'">Duration (ms)<input
      v-model.number="duration"
      aria-label="Track duration"
      min="0"
      type="number"
    /></label>
  <label v-if="kind === 'tween'">Default easing<select
      v-model="defaultEasing"
      aria-label="Track easing"
    >
      <option value="linear">linear</option><option value="ease">ease</option>
      <option value="ease-in">easeIn</option><option value="ease-out">easeOut</option><option
        value="ease-in-out"
      >easeInOut</option>
      <option value="step-start">stepStart</option><option value="step-end">stepEnd</option>
      <option
        v-if="!['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'].includes(
          defaultEasing,
        )"
        :value="defaultEasing"
      >Current expression</option>
    </select></label>
  <label v-if="kind === 'spring-duration'">Bounce<input
      v-model.number="bounce"
      max="0.99"
      min="0"
      step="0.01"
      type="number"
    /></label>
  <template v-if="kind === 'spring-physics'">
    <label>Stiffness<input v-model.number="stiffness" min="0.01" step="1" type="number" /></label>
    <label>Damping<input v-model.number="damping" min="0.01" step="1" type="number" /></label>
    <label>Mass<input v-model.number="mass" min="0.01" step="0.1" type="number" /></label>
    <p>Duration is calculated from the spring parameters.</p>
  </template>
  <button @click="applyTiming">{{ actionLabel }}</button>
</template>
