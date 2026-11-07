<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Timing } from '@liva/runtime'
import { type TimelineTrack } from '../timeline.ts'
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
const sourceValue = ref('')
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
const explicitFrame = computed(() =>
  props.track.explicit.find((frame) => frame.offset === props.offset),
)
const canChangeFrame = computed(
  () => !!props.provenance.frameDestination && props.track.timing?.kind === 'tween',
)

const editingFrame = computed(
  () =>
    !!props.pending ||
    !!frameSource.value ||
    !!explicitFrame.value ||
    (props.offset !== undefined && props.offset !== 0 && props.offset !== 1),
)
const valueSource = computed(() =>
  props.offset === 0 ? props.provenance.from : props.provenance.to,
)
const editingPath = computed(() =>
  editingFrame.value
    ? (props.provenance.frameDeclarationPath ?? props.provenance.frameDestination)
    : (valueSource.value?.path ??
      (props.offset === 0
        ? props.provenance.fromDeclarationPath
        : props.provenance.toDeclarationPath)),
)

function locationLabel(path?: string) {
  if (!path) return 'External CSS'

  const [, kind, layer, scope, name] = path.split('/')

  if (kind === 'enter' || kind === 'leave') return `Motion ${kind}`
  const label = `Layer: ${layer}`

  if (scope === 'state') return `${label} · State: ${name}`
  if (scope === 'transition') {
    // Transition paths are produced only for the effective transition in provenance.
    const transition = props.provenance.transition!

    return `${label} · ${transition.from} → ${transition.to}`
  }

  return label
}

watch(
  () => [props.track, props.provenance, props.offset, props.pending],
  () => {
    sourceValue.value = valueSource.value?.text ?? ''
    frameValue.value =
      frameSource.value?.value ?? explicitFrame.value?.value ?? valueSource.value?.text ?? ''
    frameEasing.value =
      props.provenance.fields.find((field) => field.path === `${framePath.value}/easing`)?.value ??
      ''
    framePercent.value = (props.offset ?? 0.5) * 100
  },
  { immediate: true },
)

function replaceTiming(value: Timing) {
  try {
    const expression = typedTimingText(value, props.provenance.timingBindings)

    // Timing controls are rendered only for an editable destination.
    emit('edit', [{ op: 'timing', path: props.provenance.timingDestination!, value: expression }])
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
    <p aria-label="Editing location" class="location">{{ locationLabel(editingPath) }}</p>
    <p v-if="track.diagnostic" role="alert">{{ track.diagnostic }}</p>
    <form
      v-if="!editingFrame"
      @submit.prevent="
        valueSource && emit('edit', [{ op: 'set', path: valueSource.path, value: sourceValue }])
      "
    >
      <template v-if="valueSource">
        <label>Source value<input v-model="sourceValue" aria-label="Source value" required /></label
        >
        <button type="submit">Apply value</button>
      </template>
      <p v-else>{{
        (offset === 0 ? provenance.fromDescription : provenance.toDescription) ||
          (editingPath
            ? 'Source editing is unavailable for this declaration.'
            : 'External CSS has no editable source declaration.')
      }}</p>
    </form>
    <form v-if="editingFrame && canChangeFrame && offset !== undefined" @submit.prevent="saveFrame">
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
    <h4>Timing</h4>
    <p v-if="provenance.timingUnavailable">{{ provenance.timingUnavailable }}</p>
    <template v-if="provenance.timingDestination">
      <p aria-label="Timing editing location" class="location">{{
        locationLabel(provenance.timingDestination)
      }}</p>
      <TimingControls :timing="track.timing" @apply="replaceTiming" />
      <button
        v-if="provenance.localTiming"
        type="button"
        @click="emit('edit', [{ op: 'timing', path: provenance.timingDestination! }])"
      >Remove timing override</button>
    </template>
    <p v-if="provenance.framesUnavailable">{{ provenance.framesUnavailable }}</p>

    <p
      v-if="
        track.lifecycle !== 'leave' &&
        track.explicit.some((frame) => frame.offset === 1 && frame.value !== track.toValue)
      "
    >Completion restores the property’s resolved value after this keyframe.</p>
    <button
      v-if="provenance.frameDestination"
      class="add-keyframe"
      :disabled="!canChangeFrame"
      @click="emit('add')"
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
.location {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.add-keyframe {
  display: block;
  margin-block-start: 16px;
}
</style>
