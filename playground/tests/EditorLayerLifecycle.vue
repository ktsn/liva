<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ label: string }>()
const active = ref(false)
const start = ref(0.2)
</script>

<template>
  <div v-liva:panel="{ active, start }">
    <button v-liva-target:body :aria-label="label" :aria-pressed="active" @click="active = !active">{{
      label
    }}</button>
    <span v-liva-target:badge :data-testid="`${label} badge`">Badge</span>
    <button :aria-label="`${label} start`" @click="start = 0.4">Change start</button>
  </div>
</template>

<liva lang="liva">
motion panel(active: boolean, start: number) {
  @tween(duration: 100)
  layer base {
    body { opacity: 1; scale: 1 }
  }
  layer active when active { body { opacity: 0.8 } }
  layer badge when false { badge { opacity: 1 } }

  @tween(duration: 200, easing: linear)
  enter {
    body { opacity: ${start} }
    badge { opacity: 0 }
  }
  @tween(duration: 200, easing: linear)
  leave {
    body { opacity: 0 }
    badge { opacity: 0 }
  }
}
</liva>
