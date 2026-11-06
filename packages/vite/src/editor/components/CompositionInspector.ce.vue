<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Timing } from '@liva/runtime'
import { timingText, type TimelineTrack } from '../timeline.ts'
import type { Edit } from '../communication/protocol.ts'
import { typedTimingText, type TrackProvenance } from '../provenance.ts'
import TimingControls from './TimingControls.ce.vue'

const props = defineProps<{
  track: TimelineTrack
  provenance: TrackProvenance
  offset?: number
  pending?: boolean
}>()
const emit = defineEmits<{ edit: [edits: Edit[]]; add: []; error: [error: unknown] }>()
const fromValue = ref('')
const toValue = ref('')
const timing = ref('')
const frameValue = ref('')
const frameEasing = ref('')
const framePercent = ref(50)
const framePath = computed(() =>
  props.provenance.frameDestination && props.offset !== undefined
    ? `${props.provenance.frameDestination}/frame/${props.offset}`
    : undefined,
)
const frameSource = computed(() =>
  props.provenance.fields.find((field) => field.path === `${framePath.value}/value`),
)
const selectedFrame = computed(() =>
  props.track.frames.find((frame) => frame.offset === props.offset),
)
const canChangeFrame = computed(
  () => !!props.provenance.frameDestination && props.track.timing?.kind === 'tween',
)

watch(
  () => [props.track, props.provenance, props.offset, props.pending],
  () => {
    fromValue.value = props.provenance.from?.text ?? ''
    toValue.value = props.provenance.to?.text ?? ''
    timing.value = props.provenance.localTiming?.text ?? props.provenance.timingSource?.text ?? ''
    frameValue.value = frameSource.value?.value ?? props.provenance.to?.text ?? ''
    frameEasing.value =
      props.provenance.fields.find((field) => field.path === `${framePath.value}/easing`)?.value ??
      ''
    framePercent.value = (props.offset ?? 0.5) * 100
  },
  { immediate: true },
)

function replaceTiming(value: Timing) {
  try {
    timing.value = typedTimingText(value)
  } catch (error) {
    emit('error', error)
  }
}

function saveFrame() {
  // The submitting form exists only when canChangeFrame guarantees a destination and tween timing.
  const destination = props.provenance.frameDestination!

  const offset = Math.round(framePercent.value * 10000) / 1000000

  if (props.pending || !frameSource.value) {
    emit('edit', [
      {
        op: 'addFrame',
        path: destination,
        offset,
        value: frameValue.value,
        easing: frameEasing.value || undefined,
      },
    ])
    return
  }

  const path = `${destination}/frame/${props.offset}`
  const edits: Edit[] = [
    { op: 'set', path: `${path}/value`, value: frameValue.value },
    { op: 'easing', path, value: frameEasing.value || undefined },
  ]

  if (offset !== props.offset)
    edits.push({ op: 'set', path: `${path}/offset`, value: `${offset * 100}%` })

  emit('edit', edits)
}
</script>

<template>
  <aside aria-label="Selection inspector" class="inspector">
    <h3>{{ track.target }} / {{ track.property }}</h3>
    <p>Animation owner: {{ provenance.owner }}</p>
    <p v-if="track.diagnostic" role="alert">{{ track.diagnostic }}</p>
    <p v-if="provenance.sharedValue"
    >FROM and TO share this declaration. Editing it affects both sides and every instance using this source.</p>
    <form
      @submit.prevent="
        provenance.from &&
        emit('edit', [{ op: 'set', path: provenance.from.path, value: fromValue }])
      "
    >
      <p>FROM resolved: {{ track.fromValue || 'External CSS' }}</p>
      <p class="source">{{
        provenance.from?.label || 'External CSS has no editable source declaration.'
      }}</p>
      <label v-if="provenance.from">FROM source value<input
          v-model="fromValue"
          aria-label="FROM source value"
          required
        /></label>
      <button v-if="provenance.from" type="submit">Apply FROM value</button>
    </form>
    <form
      @submit.prevent="
        provenance.to && emit('edit', [{ op: 'set', path: provenance.to.path, value: toValue }])
      "
    >
      <p>TO resolved: {{ track.toValue || 'External CSS' }}</p>
      <p class="source">{{
        provenance.to?.label || 'External CSS has no editable source declaration.'
      }}</p>
      <label v-if="provenance.to">TO source value<input
          v-model="toValue"
          aria-label="TO source value"
          required
        /></label>
      <button v-if="provenance.to" type="submit">Apply TO value</button>
    </form>
    <details v-if="provenance.overridden.length">
      <summary>Overridden declarations</summary>
      <p v-for="source in provenance.overridden" :key="source.path" class="source"
      >{{ source.label }}: {{ source.text }}</p>
    </details>
    <p class="source">Effective timing: {{ provenance.timingSource?.label || 'None' }}</p>
    <p>{{ Math.round(track.duration) }} ms</p>
    <p>Resolved timing: {{ track.timing ? timingText(track.timing) : 'None' }}</p>
    <p v-if="provenance.timingUnavailable">{{ provenance.timingUnavailable }}</p>
    <template v-if="provenance.timingDestination">
      <p class="source">Timing override destination: {{ provenance.timingDestination }}</p>
      <form
        @submit.prevent="
          emit('edit', [{ op: 'timing', path: provenance.timingDestination!, value: timing }])
        "
      >
        <label>Timing expression<input v-model="timing" aria-label="Timing expression" required /></label>
        <button type="submit">Apply timing expression</button>
        <button
          v-if="provenance.localTiming"
          type="button"
          @click="emit('edit', [{ op: 'timing', path: provenance.timingDestination! }])"
        >Remove timing override</button>
      </form>
      <details>
        <summary>Replace timing expression with parameters</summary>
        <TimingControls
          :timing="track.timing"
          action-label="Use timing parameters"
          @apply="replaceTiming"
        />
      </details>
    </template>
    <p v-if="provenance.framesUnavailable">{{ provenance.framesUnavailable }}</p>
    <p v-if="provenance.frameDestination" class="source"
    >Keyframe destination: {{ provenance.frameDestination }}</p>
    <p v-if="track.explicit.some((frame) => frame.offset === 1 && frame.value !== track.toValue)"
    >Completion restores the resolved TO value after the explicit endpoint.</p>
    <dl v-if="selectedFrame" aria-label="Selected keyframe">
      <dt>Position</dt><dd>{{ selectedFrame.offset * 100 }}%</dd>
      <dt>Resolved value</dt><dd>{{ selectedFrame.value || 'External CSS' }}</dd>
      <dt>Easing</dt><dd>{{ selectedFrame.easing || 'Track timing' }}</dd>
    </dl>
    <form v-if="canChangeFrame && offset !== undefined" @submit.prevent="saveFrame">
      <label>Keyframe source value<input
          v-model="frameValue"
          aria-label="Keyframe source value"
          required
        /></label>
      <label>Position (%)<input
          v-model.number="framePercent"
          aria-label="Keyframe percentage"
          max="100"
          min="0"
          required
          step="0.001"
          type="number"
        /></label>
      <label>Segment easing expression<input
          v-model="frameEasing"
          aria-label="Keyframe easing expression"
          placeholder="Use track easing"
        /></label>
      <button type="submit">{{
        frameSource && !pending ? 'Apply keyframe' : 'Add keyframe'
      }}</button>
      <button
        v-if="frameSource"
        type="button"
        @click="emit('edit', [{ op: 'removeFrame', path: framePath! }])"
      >Delete keyframe</button>
    </form>
    <button v-if="provenance.frameDestination" :disabled="!canChangeFrame" @click="emit('add')"
    >New keyframe at playhead</button>
    <p v-if="provenance.frameDestination && !canChangeFrame"
    >Keyframe editing requires tween timing. Springs use their solver curve.</p>
  </aside>
</template>

<style scoped>
.inspector {
  padding: 14px;
  overflow: auto;
  border-inline-start: 1px solid var(--liva-border-panel);
  background: var(--liva-surface-inspector);
}
.source {
  overflow-wrap: anywhere;
  color: var(--liva-text-muted);
}
</style>
