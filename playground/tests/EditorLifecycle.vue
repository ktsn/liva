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
  state idle { body { opacity: 1; scale: 1 } }
  state active when active { body { opacity: 0.8 } }
  transition { @tween: 100ms }
  enter { @tween: 200ms; body { opacity: ${start} } }
  enter active { body { opacity { @tween: 400ms } } }
  leave { @tween: 200ms; body { opacity: 0 } }
}
</liva>
