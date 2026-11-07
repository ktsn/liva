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
  @tween(duration: 100) layer base {
    body { opacity: 1; scale: 1 }
  }
  layer active when active { body { opacity: 0.8 } }
  @tween(duration: 200, easing: linear) enter { body { opacity: ${start} } }
  @tween(duration: 200, easing: linear) leave { body { opacity: 0 } }
}
</liva>
