<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import type { TimelineTrack } from '../timeline.ts'
import { normalizedOffset, snapTime } from '../timeline.ts'

const props = defineProps<{
  track: TimelineTrack
  extent: number
  selected?: number
  marks: number[]
}>()
const emit = defineEmits<{
  select: [offset?: number]
  add: [offset: number]
  move: [from: number, to: number]
  duration: [duration: number]
}>()
const lane = useTemplateRef<HTMLElement>('lane')
const drag = ref<{ kind: 'frame' | 'duration'; offset: number; start: number; time: number }>()
const width = computed(
  () =>
    ((drag.value?.kind === 'duration' ? drag.value.time : props.track.duration) / props.extent) *
    100,
)

function point(event: PointerEvent | MouseEvent) {
  const rect = lane.value!.getBoundingClientRect()
  const time = ((event.clientX - rect.left) / rect.width) * props.extent
  return Math.max(0, snapTime(time, props.extent, props.marks, rect.width, event.altKey))
}

function begin(event: PointerEvent, kind: 'frame' | 'duration', offset = 0) {
  if (event.button !== 0) return
  event.preventDefault()
  emit('select', kind === 'frame' ? offset : undefined)
  drag.value = {
    kind,
    offset,
    start: event.clientX,
    time: kind === 'frame' ? offset * props.track.duration : props.track.duration,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moving(event: PointerEvent) {
  if (!drag.value) return
  drag.value.time =
    drag.value.kind === 'frame' ? Math.min(props.track.duration, point(event)) : point(event)
}

function finish(event: PointerEvent) {
  const current = drag.value
  drag.value = undefined
  if (!current || Math.abs(event.clientX - current.start) < 3) return
  if (current.kind === 'duration') emit('duration', Math.round(current.time))
  else emit('move', current.offset, normalizedOffset(current.time, props.track.duration))
}

function add(event: MouseEvent) {
  const time = point(event)
  if (
    time > props.track.duration ||
    props.track.timing?.kind !== 'tween' ||
    props.track.duration === 0
  )
    return
  emit('add', normalizedOffset(time, props.track.duration))
}
</script>

<template>
  <div class="row">
    <button
      class="name"
      :aria-label="`Select ${track.target}.${track.property}`"
      @click="emit('select')"
    >
      {{ track.property }}
    </button>
    <div
      ref="lane"
      class="lane"
      :data-track="`${track.target}.${track.property}`"
      @dblclick.self="add"
    >
      <div
        class="band"
        :class="{ spring: track.timing?.kind !== 'tween' }"
        :style="{ width: `${width}%` }"
        @dblclick="add"
      >
        <button
          v-if="track.timing && track.timing.kind !== 'spring-physics'"
          class="resize"
          :aria-label="`Resize ${track.target}.${track.property}`"
          @pointerdown.stop="begin($event, 'duration')"
          @pointermove="moving"
          @pointerup="finish"
          @pointercancel="drag = undefined"
        />
      </div>
      <button
        v-for="frame in track.frames"
        :key="frame.offset"
        class="key"
        :class="{
          implicit: !track.explicit.some((f) => f.offset === frame.offset),
          selected: selected === frame.offset,
          inherited: track.inheritedFrames,
        }"
        :style="{
          left: `${((drag?.kind === 'frame' && drag.offset === frame.offset ? drag.time : frame.offset * track.duration) / extent) * 100}%`,
        }"
        :aria-label="`${track.target}.${track.property} ${Math.round(frame.offset * 100000) / 1000}%`"
        @click="emit('select', frame.offset)"
        @pointerdown.stop="begin($event, 'frame', frame.offset)"
        @pointermove="moving"
        @pointerup="finish"
        @pointercancel="drag = undefined"
      />
    </div>
  </div>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: var(--timeline-label-width) minmax(250px, 1fr);
  height: 38px;
  border-bottom: 1px solid var(--liva-border-row);
}
.name {
  position: sticky;
  left: 0;
  z-index: 7;
  text-align: left;
  padding-left: 30px;
  border: 0;
  border-radius: 0;
  background: var(--liva-surface-property);
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane {
  position: relative;
  z-index: 8;
  clip-path: inset(-10px 0 -1px calc(var(--scroll-left) - 10px));
  background-image: linear-gradient(to right, var(--liva-grid) 1px, transparent 1px);
  background-size: var(--grid-step) 100%;
  touch-action: none;
}
.band {
  position: absolute;
  top: 10px;
  height: 18px;
  background: var(--liva-track-tween);
  min-width: 1px;
}
.band.spring {
  background: var(--liva-track-spring);
}
.resize {
  position: absolute;
  right: -5px;
  width: 10px;
  height: 8px;
  top: -8px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--liva-duration-handle);
  cursor: ew-resize;
  z-index: 3;
}
.key {
  position: absolute;
  top: 13px;
  width: 12px;
  height: 12px;
  padding: 0;
  border: 2px solid var(--liva-accent);
  border-radius: 1px;
  background: var(--liva-accent);
  transform: translateX(-50%) rotate(45deg);
  z-index: 4;
  cursor: ew-resize;
  touch-action: none;
}
.key.implicit {
  background: var(--liva-surface-input);
}
.key.inherited {
  border-color: var(--liva-keyframe-inherited);
}
.key.selected {
  outline: 2px solid var(--liva-keyframe-selected);
  outline-offset: 3px;
  z-index: 5;
}
</style>
