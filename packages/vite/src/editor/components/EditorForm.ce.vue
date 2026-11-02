<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { Definition, Frame, PropertyTransition, Timing } from '@liva/runtime'
import { sampleSpring } from '@liva/runtime'
import type { EditorController } from '../controller.ts'
import type { Edit, Inspection } from '../communication/protocol.ts'
import { normalizedOffset, timelineTracks, timingText, type TimelineTrack } from '../timeline.ts'
import TimelineRow from './TimelineRow.ce.vue'
import TimelineInspector from './TimelineInspector.ce.vue'

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T
type MutableDefinition = Mutable<Definition>

const props = defineProps<{
  inspection: Inspection
  controller: EditorController
  active: boolean
  stale: boolean
}>()
const model = shallowRef<Definition>(structuredClone(props.inspection.definition))
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
const general = computed(() => scope.value === 'general')
const tracks = computed(() => timelineTracks(model.value, from.value, to.value, general.value))
const duration = computed(() => Math.max(0, ...tracks.value.map((track) => track.duration)))
const extent = computed(() => Math.max(100, Math.ceil(duration.value / 100) * 100))
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
    await props.controller.preview(to.value, from.value, general.value)
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
  let transition = general.value
    ? next.generalTransition
    : next.directionalTransitions.find((item) => item.from === from.value && item.to === to.value)
        ?.transition
  if (!transition) {
    transition = { targets: [] }
    if (general.value) next.generalTransition = transition
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
  if (!track.frames.some((frame) => frame.offset === offset)) selected.value!.pending = true
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
  if (from.value === to.value) to.value = states.find((state) => state !== from.value) ?? from.value
  endPreview()
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
  if (!props.controller.previewActive) {
    stop()
    clearTimeout(timer)
    generation++
    busy.value = false
  }
})

onScopeDispose(() => {
  unsubscribe()
  stop()
  clearTimeout(timer)
  generation++
})
</script>

<template>
  <div class="toolbar">
    <label
      >Editing<select v-model="scope" aria-label="Editing scope" @change="changeDirection">
        <option value="directional">Directional transition</option>
        <option value="general">Common settings</option>
      </select></label
    >
    <label
      >From<select v-model="from" aria-label="From state" @change="changeDirection">
        <option v-for="state in states" :key="state">{{ state }}</option>
      </select></label
    >
    <span>→</span>
    <label
      >To<select v-model="to" aria-label="To state" @change="changeDirection">
        <option v-for="state in states" :key="state" :disabled="state === from">{{ state }}</option>
      </select></label
    >
    <button
      :disabled="busy || stale || from === to || tracks.some((track) => track.diagnostic)"
      @click="play"
    >
      {{ playing ? 'Pause' : 'Play' }}
    </button>
    <button :disabled="stale" @click="seek(0)">To start</button>
    <button @click="endPreview">End preview</button>
    <span class="readout">{{ Math.round(time) }} / {{ Math.round(duration) }} ms</span>
    <div class="actions">
      <button @click="discard">Discard changes</button
      ><button :disabled="stale || !controller.draft.length" @click="save">Save to source</button>
    </div>
  </div>
  <div class="workspace">
    <div class="timeline">
      <div class="ruler">
        <span>Targets / properties</span>
        <div>
          <div class="ticks">
            <span v-for="index in 11" :key="index">{{
              Math.round(((index - 1) * extent) / 10)
            }}</span>
          </div>
          <input
            aria-label="Playhead"
            type="range"
            min="0"
            :max="extent"
            step="1"
            :value="time"
            :disabled="stale || from === to"
            @input="seek(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
      <template v-for="target in targets" :key="target">
        <div class="target-row">
          <button
            :aria-expanded="expanded.includes(target)"
            :aria-label="`Toggle ${target} tracks`"
            @click="
              expanded = expanded.includes(target)
                ? expanded.filter((item) => item !== target)
                : [...expanded, target]
            "
          >
            {{ expanded.includes(target) ? '▾' : '▸' }} {{ target }}
          </button>
          <div class="summary">
            <span
              v-for="(mark, index) in tracks
                .filter((track) => track.target === target)
                .flatMap((track) => track.frames.map((frame) => frame.offset * track.duration))"
              :key="index"
              :style="{ left: `${(mark / extent) * 100}%` }"
              >◆</span
            >
          </div>
        </div>
        <template v-if="expanded.includes(target)"
          ><TimelineRow
            v-for="track in tracks.filter((track) => track.target === target)"
            :key="track.path"
            :track="track"
            :extent="extent"
            :time="time"
            :marks="marks"
            :selected="selection === track ? selected?.offset : undefined"
            @select="choose(track, $event)"
            @add="add(track, $event)"
            @move="(old, offset) => move(track, old, offset)"
            @duration="resize(track, $event)"
        /></template>
      </template>
      <p class="hint">
        Double-click a property lane to add a keyframe. Drag keys or duration handles. Hold Alt to
        disable snapping.
      </p>
    </div>
    <TimelineInspector
      v-if="selection"
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
  border-bottom: 1px solid #ccd9d1;
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
  padding: 0 12px 20px;
}
.ruler,
.target-row {
  display: grid;
  grid-template-columns: 190px minmax(250px, 1fr);
}
.ruler {
  position: sticky;
  top: 0;
  z-index: 8;
  height: 50px;
  background: #f1f5f0;
  align-items: center;
}
.ruler > div {
  margin-right: 18px;
}
.ruler input {
  padding: 0;
  height: 16px;
  margin: 0;
  accent-color: #bd6540;
}
.ticks {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
}
.target-row {
  height: 36px;
  background: #e9f0e9;
  border-bottom: 1px solid #d4e0d7;
}
.target-row button {
  text-align: left;
  font-weight: 600;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.summary {
  position: relative;
  margin-right: 18px;
  pointer-events: none;
}
.summary span {
  position: absolute;
  top: 10px;
  transform: translateX(-50%);
  font-size: 10px;
  color: #839a8b;
}
.hint,
.empty {
  color: #77897d;
  font-size: 11px;
  padding: 14px;
}
.empty {
  border-left: 1px solid #ccd9d1;
}
@media (max-width: 760px) {
  .workspace {
    grid-template-columns: minmax(380px, 1fr) 230px;
    overflow: auto;
  }
}
</style>
