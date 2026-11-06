<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ label: string }>()
const active = ref(false)
</script>

<template>
  <button
    v-liva:panel="{ active, start: 0.2 }"
    v-liva-target:body
    :aria-label="label"
    :aria-pressed="active"
    @click="active = !active"
  >
    {{ label }}
  </button>
</template>

<liva lang="liva">
motion panel(active: boolean, start: number) {
  layer base @tween(duration: 100) {
    body { opacity: 1; scale: 1 }
  }
  layer active when active { body { opacity: 0.8 } }
  enter @tween(duration: 200, easing: linear) { body { opacity: ${start} } }
  leave @tween(duration: 200, easing: linear) { body { opacity: 0 } }
}
</liva>
