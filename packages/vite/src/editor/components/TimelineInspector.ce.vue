<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Frame, Timing } from '@liva/runtime'
import type { TimelineTrack } from '../timeline.ts'

const props = defineProps<{
  track: TimelineTrack
  offset?: number
  pending?: boolean
  from: string
  to: string
  general: boolean
}>()
const emit = defineEmits<{
  frame: [frame: Frame]
  remove: []
  timing: [timing: Timing]
  resetFrames: []
  resetTiming: []
  state: [value: string]
  add: []
  error: [message: string]
}>()
const selectedFrame = computed(() =>
  props.track.frames.find((frame) => frame.offset === props.offset),
)
const implicit = computed(
  () =>
    !props.pending &&
    props.offset !== undefined &&
    !props.track.explicit.some((frame) => frame.offset === props.offset),
)
const value = ref('')
const percent = ref(0)
const easing = ref('')
const kind = ref<Timing['kind']>('tween')
const duration = ref(350)
const bounce = ref(0.25)
const stiffness = ref(300)
const damping = ref(20)
const mass = ref(1)
const defaultEasing = ref('linear')

watch(
  () => [props.track, props.offset, props.pending],
  () => {
    value.value = selectedFrame.value?.value ?? ''
    percent.value = (props.offset ?? 0.5) * 100
    easing.value = selectedFrame.value?.easing ?? ''
    const timing = props.track.timing
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

function applyFrame() {
  if (
    !value.value.trim() ||
    !Number.isFinite(percent.value) ||
    percent.value < 0 ||
    percent.value > 100
  ) {
    emit('error', 'Enter a value and a position between 0% and 100%.')
    return
  }
  emit('frame', {
    offset: Math.round(percent.value * 10000) / 1000000,
    value: value.value,
    ...(easing.value ? { easing: easing.value } : {}),
  })
}

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
  emit('timing', timing)
}
</script>

<template>
  <aside class="inspector" aria-label="Selection inspector">
    <h3>{{ track.target }} / {{ track.property }}</h3>
    <p v-if="track.diagnostic" role="alert">{{ track.diagnostic }}</p>
    <template v-if="offset !== undefined">
      <p v-if="implicit">
        {{
          track.lifecycle
            ? 'Captured state / presentation endpoint'
            : `State ${offset === 0 ? from : to} · shared by other transitions`
        }}
      </p>
      <p v-else>
        {{
          pending
            ? 'New keyframe'
            : track.inheritedFrames
              ? track.lifecycle
                ? 'Inherited default keyframe'
                : 'Inherited common keyframe'
              : 'Local keyframe'
        }}
      </p>
      <label>Value<input v-model="value" aria-label="Keyframe value" /></label>
      <template v-if="!implicit">
        <label
          >Position (%)<input
            v-model.number="percent"
            type="number"
            min="0"
            max="100"
            step="0.1"
            aria-label="Keyframe percentage"
        /></label>
        <label
          >Time (ms)<input
            :value="Math.round((percent / 100) * track.duration * 1000) / 1000"
            type="number"
            min="0"
            :max="track.duration"
            step="1"
            :disabled="track.duration === 0"
            aria-label="Keyframe time"
            @input="
              percent = (Number(($event.target as HTMLInputElement).value) / track.duration) * 100
            "
        /></label>
        <label v-if="track.timing?.kind === 'tween' && percent < 100"
          >Easing to next keyframe<input
            v-model="easing"
            placeholder="Use track easing"
            aria-label="Keyframe easing"
        /></label>
        <button @click="applyFrame">{{ pending ? 'Add keyframe' : 'Apply keyframe' }}</button>
        <button v-if="!pending" @click="emit('remove')">Delete keyframe</button>
      </template>
      <template v-else>
        <button v-if="!track.lifecycle" @click="emit('state', value)">Update state value</button>
        <button @click="applyFrame">Create endpoint override</button>
      </template>
    </template>
    <template v-else>
      <p>{{ track.timingOrigin }} · {{ Math.round(track.duration) }} ms</p>
      <label
        >Timing<select v-model="kind" aria-label="Timing mode">
          <option value="tween">Tween</option>
          <option value="spring-duration">Duration spring</option>
          <option value="spring-physics">Physics spring</option>
        </select></label
      >
      <label v-if="kind !== 'spring-physics'"
        >Duration (ms)<input
          v-model.number="duration"
          type="number"
          min="0"
          aria-label="Track duration"
      /></label>
      <label v-if="kind === 'tween'"
        >Default easing<input v-model="defaultEasing" aria-label="Track easing"
      /></label>
      <label v-if="kind === 'spring-duration'"
        >Bounce<input v-model.number="bounce" type="number" min="0" max="0.99" step="0.01"
      /></label>
      <template v-if="kind === 'spring-physics'">
        <label
          >Stiffness<input v-model.number="stiffness" type="number" min="0.01" step="1"
        /></label>
        <label>Damping<input v-model.number="damping" type="number" min="0.01" step="1" /></label>
        <label>Mass<input v-model.number="mass" type="number" min="0.01" step="0.1" /></label>
        <p>Duration is calculated from the spring parameters.</p>
      </template>
      <button @click="applyTiming">Apply timing</button>
      <button
        :disabled="track.timing?.kind !== 'tween' || track.duration === 0"
        @click="emit('add')"
      >
        New keyframe at playhead
      </button>
    </template>
    <div v-if="!general" class="inheritance">
      <button :disabled="!track.local?.timing" @click="emit('resetTiming')">
        {{ track.lifecycle ? 'Use default timing' : 'Use common timing' }}
      </button>
      <button :disabled="!track.local?.keyframes" @click="emit('resetFrames')">
        {{ track.lifecycle ? 'Use default keyframes' : 'Use common keyframes' }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  padding: 14px;
  overflow: auto;
  border-left: 1px solid var(--liva-border-panel);
  background: var(--liva-surface-inspector);
}
h3 {
  font-size: 12px;
  margin: 0 0 10px;
  overflow-wrap: anywhere;
}
p {
  color: var(--liva-text-muted);
  font-size: 11px;
}
button {
  margin: 8px 5px 0 0;
}
.inheritance {
  border-top: 1px solid var(--liva-border-panel);
  margin-top: 14px;
  padding-top: 6px;
}
</style>
