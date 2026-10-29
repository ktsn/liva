<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ label: string }>()
const active = ref(false)
</script>
<template>
  <button
    :aria-label="label"
    :aria-pressed="active"
    v-liva:motion="active ? 'on' : 'off'"
    v-liva-target:box
    @click="active = !active"
  >
    {{ label }}
  </button>
</template>
<liva>
motion {
  state off { box { background-color: red } }
  state on { box { background-color: blue } }
  transition { timing: tween(duration: 50ms) }
}
</liva>
