<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  triggerRef,
  useTemplateRef,
} from 'vue'
import type {
  Composition,
  CompositionTransition,
  Definition,
  Frame,
  PropertyTransition,
  Timing,
} from '@liva/runtime'
import { sampleSpring } from '@liva/runtime'
import CompositionInspector from './CompositionInspector.ce.vue'
import { trackProvenance } from '../provenance.ts'
import type { EditorController } from '../controller.ts'
import type { Edit, Inspection } from '../communication/protocol.ts'
import {
  editableDefinition,
  normalizedOffset,
  timelineTracks,
  compositionTimelineTracks,
  timingText,
  type TimelineTrack,
  type LifecyclePhase,
} from '../timeline.ts'
import TimelineRow from './TimelineRow.ce.vue'
import TimelineInspector from './TimelineInspector.ce.vue'
import CompositionSelectors from './CompositionSelectors.ce.vue'
import { copyComposition, compatibleTransition, selectTransition } from '../compositions.ts'

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T
type MutableDefinition = Mutable<Definition>

const props = defineProps<{
  inspection: Inspection
  controller: EditorController
  active: boolean
  stale: boolean
}>()
const candidateInspection = shallowRef(props.inspection)
const model = shallowRef<Definition>(editableDefinition(props.inspection.definition))
const layers = model.value.layers ?? []
const layered = layers.length > 0
// An inspected form belongs to the selected instance; changing selection replaces the form.
const selectedRuntime = shallowRef(props.controller.selected!.binding.runtime)
const initialComposition = selectedRuntime.value.composition ?? { layers: {}, states: {} }
const compositionFrom = shallowRef(copyComposition(initialComposition))
const compositionTo = shallowRef(copyComposition(initialComposition))
const selectedTransition = shallowRef<CompositionTransition>()
const states = model.value.states.map((state) => state.name)
const from = ref(states[0])
const to = ref(states[1] ?? states[0])
const scope = ref('directional')
const expanded = ref<string[]>([])
const selected = ref<{ target: string; property: string; offset?: number; pending?: boolean }>()
const time = ref(0)
const playing = ref(false)
const busy = ref(false)
let frameId = 0
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
const phase = computed<LifecyclePhase | undefined>(() =>
  scope.value.startsWith('enter') ? 'enter' : scope.value.startsWith('leave') ? 'leave' : undefined,
)
const general = computed(() => scope.value === 'general' || scope.value.endsWith('-default'))
const timelineResult = computed(() => {
  try {
    if (!layered)
      return {
        tracks: timelineTracks(model.value, from.value, to.value, general.value, phase.value),
      }

    const runtime = selectedRuntime.value
    const before = compositionFrom.value
    const after = compositionTo.value

    return {
      tracks: compositionTimelineTracks(
        runtime.inspectComposition(before, undefined, [], model.value),
        runtime.inspectComposition(
          after,
          before,
          selectedTransition.value ? [selectedTransition.value] : [],
          model.value,
        ),
      ),
    }
  } catch (error) {
    return { tracks: [], error }
  }
})
const tracks = computed(() => timelineResult.value.tracks)

const duration = computed(() => Math.max(0, ...tracks.value.map((track) => track.duration)))
const timelineLabelWidth = 190

const zoom = ref(1)
const zoomTail = ref(0)
const baseExtent = computed(() =>
  Math.max(100, Math.ceil(duration.value / Math.min(1, zoom.value) / 100) * 100),
)
const extent = computed(() => baseExtent.value + zoomTail.value)

const horizontalScroll = ref(0)

const pan = ref<{ x: number; scrollLeft: number }>()

const timeline = useTemplateRef<HTMLElement>('timeline')
const rulerLane = useTemplateRef<HTMLElement>('rulerLane')

const viewportWidth = ref(1000)

const tickInterval = computed(() => {
  const laneWidth =
    (Math.max(1, viewportWidth.value - timelineLabelWidth) *
      Math.max(1, zoom.value) *
      extent.value) /
    baseExtent.value
  const ideal = (extent.value * 80) / laneWidth

  const magnitude = 10 ** Math.floor(Math.log10(ideal))
  const normalized = ideal / magnitude

  const step =
    normalized < Math.sqrt(2)
      ? 1
      : normalized < Math.sqrt(10)
        ? 2
        : normalized < Math.sqrt(50)
          ? 5
          : 10

  return step * magnitude
})

const ticks = computed(() =>
  Array.from({ length: Math.floor(extent.value / tickInterval.value) + 1 }, (_, index) =>
    Number((index * tickInterval.value).toPrecision(12)),
  ),
)

let timelineObserver: ResizeObserver | undefined

onMounted(() => {
  timelineObserver = new ResizeObserver(([entry]) => {
    viewportWidth.value = entry.contentRect.width
  })

  timelineObserver.observe(timeline.value!)
})

const targets = computed(() => [...new Set(tracks.value.map((track) => track.target))])
const marks = computed(() =>
  tracks.value.flatMap((track) => track.frames.map((frame) => frame.offset * track.duration)),
)
const selection = computed(() =>
  tracks.value.find(
    (track) =>
      track.target === selected.value?.target && track.property === selected.value?.property,
  ),
)

const selectionProvenance = computed(
  () =>
    selection.value &&
    trackProvenance(
      candidateInspection.value,
      compositionFrom.value,
      compositionTo.value,
      selectedTransition.value,
      selection.value.target,
      selection.value.property,
    ),
)

async function changeZoom(value: number) {
  const scroller = timeline.value!
  const lane = rulerLane.value!
  const leftTime = (scroller.scrollLeft / lane.getBoundingClientRect().width) * extent.value

  zoom.value = value

  const laneWidth = Math.max(250, scroller.clientWidth - timelineLabelWidth) * Math.max(1, value)
  const scrollLeft = (leftTime / baseExtent.value) * laneWidth

  zoomTail.value = Math.max(
    0,
    Math.ceil(
      (leftTime +
        ((scroller.clientWidth - timelineLabelWidth) / laneWidth) * baseExtent.value -
        baseExtent.value) /
        100,
    ) * 100,
  )

  await nextTick()

  scroller.scrollLeft = scrollLeft
}

function beginPan(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select')) return

  pan.value = { x: event.clientX, scrollLeft: timeline.value!.scrollLeft }
}

function movePan(event: PointerEvent) {
  if (!pan.value || Math.abs(event.clientX - pan.value.x) < 3) return

  timeline.value!.setPointerCapture(event.pointerId)
  timeline.value!.scrollLeft = pan.value.scrollLeft + pan.value.x - event.clientX
}

function endPan() {
  pan.value = undefined
}

function report(error: unknown) {
  props.controller.report(error)
}

function stop() {
  playing.value = false
  cancelAnimationFrame(frameId)
}

function endPreview() {
  generation++
  clearTimeout(timer)
  stop()
  busy.value = false
  props.controller.endPreview()
}

async function prepare() {
  const current = ++generation
  busy.value = true
  try {
    if (layered) {
      const reply = await props.controller.previewComposition(
        compositionFrom.value,
        compositionTo.value,
        selectedTransition.value ? [selectedTransition.value] : [],
      )

      if (reply && current === generation) {
        candidateInspection.value = reply
        model.value = reply.definition
      }
    } else
      await props.controller.preview(
        to.value,
        phase.value ? undefined : from.value,
        general.value,
        phase.value,
      )
    if (current !== generation || !props.controller.previewActive) return false
    props.controller.seek(time.value)
    return true
  } catch (error) {
    report(error)
    return false
  } finally {
    if (current === generation) busy.value = false
  }
}

async function seek(value: number) {
  stop()
  time.value = Math.max(0, Math.min(duration.value, value))
  if (!props.controller.previewActive) await prepare()
  props.controller.seek(time.value)
}

async function play() {
  if (playing.value) {
    stop()
    return
  }
  clearTimeout(timer)
  if (time.value >= duration.value) time.value = 0
  if (!props.controller.previewActive && !(await prepare())) return
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await seek(duration.value)
    return
  }
  playing.value = true
  const start = performance.now() - time.value
  const tick = (now: number) => {
    /* v8 ignore if -- @preserve: stop and controller notifications cancel scheduled frames synchronously; this only guards an already queued browser callback. */
    if (!playing.value || !props.controller.previewActive) {
      stop()
      return
    }
    time.value = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? duration.value
      : Math.min(duration.value, now - start)
    props.controller.seek(time.value)
    if (time.value < duration.value) frameId = requestAnimationFrame(tick)
    else stop()
  }
  frameId = requestAnimationFrame(tick)
}

async function editComposition(edits: Edit[]) {
  endPreview()
  const editingSelection = selected.value
  const previous = props.controller.draft
  const candidate = [...previous, ...edits]
  props.controller.setDraft(candidate)
  const succeeded = await prepare()

  if (!succeeded && props.controller.draft === candidate) props.controller.setDraft(previous)

  if (succeeded && selected.value === editingSelection && editingSelection) {
    for (const edit of edits) {
      if (edit.op === 'addFrame')
        selected.value = { ...editingSelection, offset: (edit.offset * 100) / 100, pending: false }
      else if (edit.op === 'set' && edit.path.endsWith('/offset'))
        selected.value = {
          ...editingSelection,
          offset: parseFloat(edit.value) / 100,
          pending: false,
        }
      else if (edit.op === 'removeFrame')
        selected.value = { target: editingSelection.target, property: editingSelection.property }
    }
  }
}

function schedule(edit: Edit, definition: Definition) {
  endPreview()
  model.value = definition
  props.controller.setDraft([
    ...props.controller.draft.filter(
      (old) =>
        !(
          'path' in old &&
          old.path ===
            ('path' in edit
              ? edit.path
              : /* v8 ignore next -- @preserve: This form schedules only set and track edits, both with paths. */ '')
        ),
    ),
    edit,
  ])
  timer = setTimeout(() => void prepare(), 150)
}

function updateTrack(track: TimelineTrack, patch: Partial<PropertyTransition>) {
  const next = structuredClone(model.value) as MutableDefinition
  let transition = phase.value
    ? next[phase.value]
    : general.value
      ? next.generalTransition
      : next.directionalTransitions.find((item) => item.from === from.value && item.to === to.value)
          ?.transition

  if (!transition) {
    transition = { targets: [] }

    if (phase.value) {
      next[phase.value] = transition
    } else if (general.value) next.generalTransition = transition
    else next.directionalTransitions.push({ from: from.value, to: to.value, transition })
  }

  let target = transition.targets.find((item) => item.name === track.target)

  if (!target) {
    target = { name: track.target, properties: [] }
    transition.targets.push(target)
  }

  const property = structuredClone({
    ...track.local,
    name: track.property,
    ...patch,
  }) as Mutable<PropertyTransition>
  const index = target.properties.findIndex((item) => item.name === track.property)
  if (index < 0) target.properties.push(property)
  else target.properties[index] = property
  schedule(
    {
      op: 'track',
      path: track.path,
      timing: property.timing ? timingText(property.timing) : undefined,
      frames: property.keyframes,
    },
    next,
  )
}

function choose(track: TimelineTrack, offset?: number) {
  selected.value = { target: track.target, property: track.property, offset }
}

function add(track: TimelineTrack, offset: number) {
  if (track.timing?.kind !== 'tween' || track.duration === 0 || offset < 0 || offset > 1) return

  choose(track, offset)

  // choose selects an existing track, so a layered selection has provenance.
  const existing = layered
    ? selectionProvenance.value!.fields.some(
        (field) =>
          field.path === `${selectionProvenance.value!.frameDestination}/frame/${offset}/value`,
      )
    : track.frames.some((frame) => frame.offset === offset)

  if (!existing) selected.value!.pending = true
}

function changeFrame(track: TimelineTrack, frame: Frame) {
  const old = selected.value?.offset
  if (
    track.explicit.some(
      (item) => item.offset === frame.offset && (item.offset !== old || selected.value?.pending),
    )
  ) {
    report('A keyframe already exists at this position.')
    return
  }
  if (track.timing?.kind !== 'tween' && ((frame.offset > 0 && frame.offset < 1) || frame.easing)) {
    report('Spring tracks only support endpoints without easing.')
    return
  }
  const frames = track.explicit.filter((item) => item.offset !== old)
  updateTrack(track, { keyframes: [...frames, frame].toSorted((a, b) => a.offset - b.offset) })
  choose(track, frame.offset)
}

function move(track: TimelineTrack, old: number, offset: number) {
  if (!track.explicit.some((frame) => frame.offset === old)) {
    report('State endpoints cannot be moved. Create an endpoint override first.')
    return
  }
  choose(track, old)
  changeFrame(track, { ...track.explicit.find((frame) => frame.offset === old)!, offset })
}

function remove(track: TimelineTrack) {
  let frames = track.explicit.filter((frame) => frame.offset !== selected.value?.offset)
  // An empty source collection means inherit. Explicit endpoints suppress inherited intermediates.
  if (!general.value && frames.length === 0)
    frames = track.frames
      .filter((frame) => frame.offset === 0 || frame.offset === 1)
      .map(({ offset, value }) => ({ offset, value }))
  updateTrack(track, { keyframes: frames.length ? frames : undefined })
  choose(track)
}

function timing(track: TimelineTrack, value: Timing) {
  try {
    if (value.kind === 'tween') {
      if (!Number.isFinite(value.durationMs) || value.durationMs < 0 || !value.easing.trim())
        throw new Error('Enter a nonnegative duration and easing.')
    } else sampleSpring(value)
    if (
      value.kind !== 'tween' &&
      track.explicit.some((frame) => (frame.offset > 0 && frame.offset < 1) || frame.easing)
    )
      throw new Error('Remove intermediate keyframes and frame easing before choosing Spring.')
    updateTrack(track, { timing: value })
  } catch (error) {
    report(error)
  }
}

function resize(track: TimelineTrack, value: number) {
  /* v8 ignore else -- @preserve: TimelineRow renders resize handles only for duration-based timing. */
  if (track.timing && track.timing.kind !== 'spring-physics')
    timing(track, { ...track.timing, durationMs: value })
}

function stateValue(track: TimelineTrack, value: string) {
  if (!value.trim()) {
    report('Enter a state value.')
    return
  }
  const name = selected.value?.offset === 0 ? from.value : to.value
  const next = structuredClone(model.value) as MutableDefinition
  next.states
    .find((state) => state.name === name)!
    .targets.find((target) => target.name === track.target)!
    .properties.find((property) => property.name === track.property)!.value = value
  schedule(
    {
      op: 'set',
      path: `${next.name}/state/${name}/target/${track.target}/${track.property}`,
      value,
    },
    next,
  )
}

function changeDirection() {
  if (!phase.value && from.value === to.value)
    to.value = states.find((state) => state !== from.value) ?? from.value
  endPreview()
  selected.value = undefined
  time.value = 0
}

function changeComposition(side: 'from' | 'to', composition: Composition) {
  endPreview()

  if (side === 'from') compositionFrom.value = composition
  else compositionTo.value = composition

  selectedTransition.value = compatibleTransition(
    model.value,
    compositionFrom.value,
    compositionTo.value,
    selectedTransition.value,
  )
  selected.value = undefined
  time.value = 0
}

function swapCompositions() {
  const before = compositionFrom.value
  const after = compositionTo.value
  endPreview()
  compositionFrom.value = copyComposition(after)
  compositionTo.value = copyComposition(before)
  selectedTransition.value = compatibleTransition(
    model.value,
    after,
    before,
    selectedTransition.value,
  )
  selected.value = undefined
  time.value = 0
}

function chooseTransition(identity: CompositionTransition | undefined) {
  endPreview()
  selectedTransition.value = identity

  if (identity) {
    const next = selectTransition(model.value, compositionFrom.value, compositionTo.value, identity)
    compositionFrom.value = next.from
    compositionTo.value = next.to
  }

  selected.value = undefined
  time.value = 0
}

async function save() {
  endPreview()
  try {
    await props.controller.commit()
  } catch (error) {
    report(error)
  }
}
async function discard() {
  endPreview()
  try {
    await props.controller.cancel()
  } catch (error) {
    report(error)
  }
}

const unsubscribe = props.controller.subscribe(() => {
  triggerRef(selectedRuntime)
  if (!props.controller.previewActive) {
    stop()
    clearTimeout(timer)
    generation++
    busy.value = false
  }
})

onScopeDispose(() => {
  timelineObserver?.disconnect()
  unsubscribe()
  stop()
  clearTimeout(timer)
  generation++
})
</script>

<template>
  <CompositionSelectors
    v-if="layered"
    :layers="layers"
    :from="compositionFrom"
    :to="compositionTo"
    :transition="selectedTransition"
    @change="changeComposition"
    @swap="swapCompositions"
    @transition="chooseTransition"
  />
  <p v-if="timelineResult.error" role="alert">{{ String(timelineResult.error) }}</p>
  <div class="toolbar">
    <label v-if="!layered">Editing<select
        v-model="scope"
        aria-label="Editing scope"
        @change="changeDirection"
      >
        <option value="directional">Directional transition</option>
        <option value="general">Common settings</option>
        <option value="enter-default">Enter · default</option>
        <option value="leave-default">Leave · default</option>
      </select></label>
    <label v-if="!layered && !phase">From<select
        v-model="from"
        aria-label="From state"
        @change="changeDirection"
      >
        <option v-for="state in states" :key="state">{{ state }}</option>
      </select></label>
    <span v-if="!layered && !phase">→</span>
    <label v-if="!layered">{{
        phase ? 'State' : 'To'
      }}<select v-model="to" aria-label="To state" @change="changeDirection">
        <option v-for="state in states" :key="state" :disabled="!phase && state === from">
          {{ state }}
        </option>
      </select></label>
    <button
      :disabled="
        busy ||
        stale ||
        !!timelineResult.error ||
        (!layered && !phase && from === to) ||
        tracks.some((track) => track.diagnostic)
      "
      @click="play"
    >
      {{ playing ? 'Pause' : 'Play' }}
    </button>
    <button :disabled="stale" @click="seek(0)">To start</button>
    <button @click="endPreview">End preview</button>
    <span aria-label="Playback time" class="readout" role="timer"
    >{{ Math.round(time) }} / {{ Math.round(duration) }} ms</span>
    <div aria-label="Timeline zoom" class="zoom-controls" role="group">
      <button aria-label="Zoom out timeline" @click="changeZoom(zoom / 1.25)">−</button>
      <input
        aria-label="Timeline zoom level"
        class="zoom-slider"
        type="range"
        :min="Math.min(-4, Math.log2(zoom))"
        :max="Math.max(4, Math.log2(zoom))"
        step="0.01"
        :value="Math.log2(zoom)"
        @input="changeZoom(2 ** Number(($event.target as HTMLInputElement).value))"
      />
      <button aria-label="Zoom in timeline" @click="changeZoom(zoom * 1.25)">+</button>
    </div>
    <div class="actions">
      <button @click="discard">Discard changes</button><button
        :disabled="stale || !controller.draft.length"
        @click="save"
      >Save to source</button>
    </div>
  </div>
  <div class="workspace">
    <div
      ref="timeline"
      aria-label="Animation timeline"
      role="region"
      :class="{ panning: pan }"
      class="timeline"
      :style="{
        '--timeline-label-width': `${timelineLabelWidth}px`,
        '--scroll-left': `${horizontalScroll}px`,
        '--playhead': `${(time / extent) * 100}%`,
        '--grid-step': `${(tickInterval / extent) * 100}%`,
      }"
      @pointerdown="beginPan"
      @pointermove="movePan"
      @pointerup="endPan"
      @pointercancel="endPan"
      @pointerleave="endPan"
      @lostpointercapture="endPan"
      @scroll="horizontalScroll = ($event.target as HTMLElement).scrollLeft"
    >
      <div
        class="timeline-content"
        data-testid="timeline-content"
        :style="{
          width: `calc(var(--timeline-label-width) + (100% - var(--timeline-label-width)) * ${(Math.max(1, zoom) * extent) / baseExtent})`,
        }"
      >
        <div class="ruler">
          <span>Targets / properties</span>
          <div ref="rulerLane" class="ruler-lane" data-testid="timeline-ruler-lane">
            <div class="ticks">
              <span
                v-for="tick in ticks"
                :key="tick"
                data-testid="timeline-tick"
                :style="{ left: `${(tick / extent) * 100}%` }"
              >{{ tick }}</span>
            </div>
            <span aria-hidden="true" class="playhead-marker" />
            <input
              aria-label="Playhead"
              min="0"
              type="range"
              :max="extent"
              step="1"
              :value="time"
              :disabled="stale || !!timelineResult.error || (!layered && !phase && from === to)"
              @input="seek(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>
        <template v-for="target in targets" :key="target">
          <button
            class="target-row"
            :aria-expanded="expanded.includes(target)"
            :aria-label="`Toggle ${target} tracks`"
            @click="expanded = expanded.includes(target)
              ? expanded.filter((item) => item !== target)
              : [...expanded, target]"
          >
            <span class="target-name"
            >{{ expanded.includes(target) ? '▾' : '▸' }} {{ target }}</span>
            <span aria-hidden="true" class="summary">
              <span
                v-for="(mark, index) in tracks
                  .filter((track) => track.target === target)
                  .flatMap((track) => track.frames.map((frame) => frame.offset * track.duration))"
                :key="index"
                :style="{ left: `${(mark / extent) * 100}%` }"
              />
            </span>
          </button>
          <template v-if="expanded.includes(target)"><TimelineRow
              v-for="track in tracks.filter((track) => track.target === target)"
              :key="track.path"
              :track="track"
              :extent="extent"
              :marks="marks"
              :selected="selection === track ? selected?.offset : undefined"
              @select="choose(track, $event)"
              @add="add(track, $event)"
              @move="(old, offset) => move(track, old, offset)"
              @duration="resize(track, $event)"
            /></template>
        </template>
        <div aria-hidden="true" class="playhead-overlay"><span /></div>
      </div>
    </div>
    <CompositionInspector
      v-if="selection && layered"
      :track="selection"
      :provenance="selectionProvenance!"
      :offset="selected?.offset"
      :pending="selected?.pending"
      @edit="editComposition"
      @add="add(selection!, time / selection!.duration)"
      @error="report"
    />
    <TimelineInspector
      v-else-if="selection"
      :track="selection"
      :offset="selected?.offset"
      :pending="selected?.pending"
      :from="from"
      :to="to"
      :general="general"
      @frame="changeFrame(selection!, $event)"
      @remove="remove(selection!)"
      @timing="timing(selection!, $event)"
      @reset-frames="updateTrack(selection!, { keyframes: undefined })"
      @reset-timing="updateTrack(selection!, { timing: undefined })"
      @state="stateValue(selection!, $event)"
      @add="add(selection!, time / selection!.duration)"
      @error="report"
    />
    <aside v-else class="empty">Select a property or keyframe to edit its settings.</aside>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--liva-border-panel);
}
.toolbar label {
  display: flex;
  gap: 5px;
  align-items: center;
  margin: 0;
}
.toolbar select {
  width: auto;
  max-width: 180px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.readout {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.workspace {
  display: grid;
  grid-template-columns: minmax(460px, 1fr) 270px;
  height: min(380px, 45vh);
}
.timeline {
  overflow: auto;
  padding: 0 0 20px;
  cursor: grab;
  touch-action: pan-y;
  user-select: none;
}
.timeline.panning {
  cursor: grabbing;
}
.ruler,
.target-row {
  display: grid;
  grid-template-columns: var(--timeline-label-width) minmax(250px, 1fr);
}
.ruler {
  position: sticky;
  top: 0;
  z-index: 12;
  height: 36px;
  background: var(--liva-surface-ruler);
  align-items: center;
}
.timeline-content {
  position: relative;
  overflow: clip;
  min-width: 440px;
}
.ruler > span {
  padding-left: 10px;
  position: sticky;
  left: 0;
  height: 100%;
  display: flex;
  align-items: center;
  background: var(--liva-surface-ruler);
  z-index: 10;
}
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zoom-slider {
  width: 120px;
  min-width: 0;
  padding: 0;
  margin: 0;
  accent-color: var(--liva-accent);
  cursor: pointer;
}
.ruler-lane {
  position: relative;
  z-index: 11;
  clip-path: inset(0 0 0 calc(var(--scroll-left) - 24px));
  height: 36px;
}
.ruler-lane::after {
  content: '';
  position: absolute;
  left: var(--playhead);
  top: 32px;
  bottom: 0;
  width: 1px;
  transform: translateX(-50%);
  background: var(--liva-playhead);
  pointer-events: none;
}
.playhead-overlay {
  position: absolute;
  top: 36px;
  bottom: 0;
  left: var(--timeline-label-width);
  right: 0;
  pointer-events: none;
  z-index: 9;
  clip-path: inset(0 0 0 calc(var(--scroll-left) - 1px));
}
.playhead-overlay span {
  position: absolute;
  left: var(--playhead);
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-50%);
  background: var(--liva-playhead);
}
.ruler input {
  appearance: none;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  opacity: 0;
  z-index: 2;
  padding: 0;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: ew-resize;
}
.ruler input::-webkit-slider-thumb {
  appearance: none;
  width: 0;
  height: 16px;
  background: var(--liva-playhead);
  clip-path: polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%);
}
.ruler input::-moz-range-thumb {
  width: 0;
  height: 16px;
  border: 0;
  border-radius: 0;
  background: var(--liva-playhead);
  clip-path: polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%);
}
.playhead-marker {
  position: absolute;
  left: var(--playhead);
  top: 16px;
  width: 14px;
  height: 16px;
  transform: translateX(-50%);
  background: var(--liva-playhead);
  clip-path: polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%);
  pointer-events: none;
}
.ruler-lane:focus-within .playhead-marker {
  background: var(--liva-playhead-focus);
}
.ticks {
  position: relative;
  height: 16px;
  font-size: 10px;
}
.ticks span {
  position: absolute;
  transform: translateX(-50%);
  background: var(--liva-surface-ruler);
}
.ruler-lane,
.summary {
  background-image: linear-gradient(to right, var(--liva-grid) 1px, transparent 1px);
  background-size: var(--grid-step) 100%;
}
.target-row {
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  text-align: left;
  height: 36px;
  background: var(--liva-surface-target);
  border-bottom: 1px solid var(--liva-border-row);
}
.target-name {
  display: flex;
  align-items: center;
  padding: 7px 10px;
  position: sticky;
  left: 0;
  z-index: 7;
  text-align: left;
  font-weight: 600;
  border: 0;
  border-radius: 0;
  background: var(--liva-surface-target);
}
.summary {
  position: relative;
  z-index: 8;
  clip-path: inset(0 0 0 calc(var(--scroll-left) - 10px));
  pointer-events: none;
}
.summary span::before {
  content: '◆';
}
.summary span {
  position: absolute;
  top: 10px;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--liva-keyframe-summary);
}
.empty {
  color: var(--liva-text-muted);
  font-size: 11px;
  padding: 14px;
}
.empty {
  border-left: 1px solid var(--liva-border-panel);
}
@media (max-width: 760px) {
  .workspace {
    grid-template-columns: minmax(380px, 1fr) 230px;
    overflow: auto;
  }
}
</style>
