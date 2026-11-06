<script setup lang="ts">
import type { TimelineTrack } from '../timeline.ts'

defineProps<{
  track: TimelineTrack
  extent: number
  selected?: number
}>()
const emit = defineEmits<{ select: [offset?: number] }>()
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
    <div class="lane" :data-track="`${track.target}.${track.property}`">
      <div
        class="band"
        :class="{ spring: track.timing?.kind !== 'tween' }"
        :style="{ inlineSize: `${(track.duration / extent) * 100}%` }"
      />
      <button
        v-for="frame in track.frames"
        :key="frame.offset"
        class="key"
        :class="{
          implicit: !track.explicit.some((f) => f.offset === frame.offset),
          selected: selected === frame.offset,
        }"
        :style="{
          insetInlineStart: `${((frame.offset * track.duration) / extent) * 100}%`,
        }"
        :aria-label="
          `${track.target}.${track.property} ${Math.round(frame.offset * 100000) / 1000}%`
        "
        @click="emit('select', frame.offset)"
      />
    </div>
  </div>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: var(--timeline-label-width) minmax(250px, 1fr);
  block-size: 38px;
  border-block-end: 1px solid var(--liva-border-row);
}
.name {
  position: sticky;
  inset-inline-start: 0;
  z-index: 7;
  text-align: start;
  padding-inline-start: 30px;
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
}
.band {
  position: absolute;
  inset-block-start: 10px;
  block-size: 18px;
  background: var(--liva-track-tween);
  min-inline-size: 1px;
  &.spring {
    background: var(--liva-track-spring);
  }
}
.key {
  position: absolute;
  inset-block-start: 13px;
  inline-size: 12px;
  block-size: 12px;
  padding: 0;
  border: 2px solid var(--liva-accent);
  border-radius: 1px;
  background: var(--liva-accent);
  transform: translateX(-50%) rotate(45deg);
  z-index: 4;
  cursor: pointer;
  &.implicit {
    background: var(--liva-surface-input);
  }
  &.selected {
    outline: 2px solid var(--liva-keyframe-selected);
    outline-offset: 3px;
    z-index: 5;
  }
}
</style>
