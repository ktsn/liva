<script setup>
import { ref } from 'vue'

const active = ref(false)
</script>

<template>
  <button
    v-liva:fade="{ active }"
    v-liva-target:button
    :aria-pressed="active"
    @click="active = !active"
  >
    Toggle opacity
  </button>
</template>

<liva lang="liva">
motion fade(active: boolean) {
  @tween(duration: 100, easing: linear)
  layer base { button { opacity: 0.5 } }
  layer active when active { button { opacity: 1 } }
}
</liva>
