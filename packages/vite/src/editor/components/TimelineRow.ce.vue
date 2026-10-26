<script setup lang="ts">
import { computed, ref } from "vue";
import type { TimelineTrack } from "../timeline.ts";
import { normalizedOffset, snapTime } from "../timeline.ts";

const props = defineProps<{
  track: TimelineTrack;
  extent: number;
  time: number;
  selected?: number;
  marks: number[];
}>();
const emit = defineEmits<{
  select: [offset?: number];
  add: [offset: number];
  move: [from: number, to: number];
  duration: [duration: number];
}>();
const lane = ref<HTMLElement>();
const drag = ref<{ kind: "frame" | "duration"; offset: number; start: number; time: number }>();
const width = computed(
  () =>
    ((drag.value?.kind === "duration" ? drag.value.time : props.track.duration) / props.extent) *
    100,
);

function point(event: PointerEvent | MouseEvent) {
  const rect = lane.value!.getBoundingClientRect();
  const time = ((event.clientX - rect.left) / rect.width) * props.extent;
  return Math.max(0, snapTime(time, props.extent, props.marks, rect.width, event.altKey));
}

function begin(event: PointerEvent, kind: "frame" | "duration", offset = 0) {
  if (event.button !== 0) return;
  event.preventDefault();
  emit("select", kind === "frame" ? offset : undefined);
  drag.value = {
    kind,
    offset,
    start: event.clientX,
    time: kind === "frame" ? offset * props.track.duration : props.track.duration,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moving(event: PointerEvent) {
  if (!drag.value) return;
  drag.value.time =
    drag.value.kind === "frame" ? Math.min(props.track.duration, point(event)) : point(event);
}

function finish(event: PointerEvent) {
  const current = drag.value;
  drag.value = undefined;
  if (!current || Math.abs(event.clientX - current.start) < 3) return;
  if (current.kind === "duration") emit("duration", Math.round(current.time));
  else emit("move", current.offset, normalizedOffset(current.time, props.track.duration));
}

function add(event: MouseEvent) {
  const time = point(event);
  if (
    time > props.track.duration ||
    props.track.timing?.kind !== "tween" ||
    props.track.duration === 0
  )
    return;
  emit("add", normalizedOffset(time, props.track.duration));
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
      <span class="playhead" :style="{ left: `${(time / extent) * 100}%` }" />
    </div>
  </div>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 190px minmax(250px, 1fr);
  height: 38px;
  border-bottom: 1px solid #e2e8e4;
}
.name {
  text-align: left;
  padding-left: 30px;
  border: 0;
  border-radius: 0;
  background: #f5f7f4;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane {
  position: relative;
  margin-right: 18px;
  background: repeating-linear-gradient(
    90deg,
    transparent 0,
    transparent calc(10% - 1px),
    #e2e8e4 calc(10% - 1px),
    #e2e8e4 10%
  );
  touch-action: none;
}
.band {
  position: absolute;
  top: 10px;
  height: 18px;
  background: #bed7cb;
  min-width: 1px;
}
.band.spring {
  background: #d7cfeb;
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
  background: #729887;
  cursor: ew-resize;
  z-index: 3;
}
.key {
  position: absolute;
  top: 13px;
  width: 12px;
  height: 12px;
  padding: 0;
  border: 2px solid #326653;
  border-radius: 1px;
  background: #326653;
  transform: translateX(-50%) rotate(45deg);
  z-index: 4;
  cursor: ew-resize;
  touch-action: none;
}
.key.implicit {
  background: #fff;
}
.key.inherited {
  border-color: #81729d;
}
.key.selected {
  outline: 2px solid #d98d3a;
  outline-offset: 3px;
  z-index: 5;
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #bd6540;
  pointer-events: none;
  z-index: 6;
}
</style>
