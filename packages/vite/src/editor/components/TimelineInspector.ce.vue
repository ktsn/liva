<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Frame, Timing } from '@liva/runtime'
import { timingText, type TimelineTrack } from '../timeline.ts'
import TimingControls from './TimingControls.ce.vue'

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

watch(
  () => [props.track, props.offset, props.pending],
  () => {
    value.value = selectedFrame.value?.value ?? ''
    percent.value = (props.offset ?? 0.5) * 100
    easing.value = selectedFrame.value?.easing ?? ''
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
</script>

<template>
  <aside aria-label="Selection inspector" class="inspector">
    <h3>{{ track.target }} / {{ track.property }}</h3>
    <p v-if="track.diagnostic" role="alert">{{ track.diagnostic }}</p>
    <template v-if="track.readonly">
      <p>{{ track.timingOrigin }}</p>
      <dl>
        <dt>FROM</dt><dd>{{ track.fromValue || 'External CSS' }}</dd>
        <dt>TO</dt><dd>{{ track.toValue || 'External CSS' }}</dd>
        <dt>Duration</dt><dd>{{ Math.round(track.duration) }} ms</dd>
        <dt>Timing</dt><dd>{{ track.timing ? timingText(track.timing) : 'None' }}</dd>
      </dl>
      <dl v-if="selectedFrame" aria-label="Selected keyframe">
        <dt>Position</dt><dd>{{ selectedFrame.offset * 100 }}%</dd>
        <dt>Value</dt><dd>{{ selectedFrame.value || 'External CSS' }}</dd>
        <dt>Easing</dt><dd>{{ selectedFrame.easing || 'Track timing' }}</dd>
      </dl>
      <p>This preview is read-only.</p>
    </template>
    <template v-else-if="offset !== undefined">
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
        <label>Position (%)<input
            v-model.number="percent"
            aria-label="Keyframe percentage"
            max="100"
            min="0"
            step="0.1"
            type="number"
          /></label>
        <label>Time (ms)<input
            :value="Math.round((percent / 100) * track.duration * 1000) / 1000"
            min="0"
            type="number"
            :max="track.duration"
            step="1"
            :disabled="track.duration === 0"
            aria-label="Keyframe time"
            @input="
              percent = (Number(($event.target as HTMLInputElement).value) / track.duration) * 100
            "
          /></label>
        <label v-if="track.timing?.kind === 'tween' && percent < 100">Easing to next keyframe<input
            v-model="easing"
            aria-label="Keyframe easing"
            placeholder="Use track easing"
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
      <TimingControls :timing="track.timing" @apply="emit('timing', $event)" />
      <button
        :disabled="track.timing?.kind !== 'tween' || track.duration === 0"
        @click="emit('add')"
      >
        New keyframe at playhead
      </button>
    </template>
    <div v-if="!track.readonly && !general" class="inheritance">
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
