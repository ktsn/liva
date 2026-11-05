<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ label: string }>()
const active = ref(false)
</script>

<template>
  <button
    v-liva:motion="{ checked: active }"
    v-liva-target:box
    :aria-label="label"
    :aria-pressed="active"
    @click="active = !active"
  >
    {{ label }}
  </button>
</template>

<liva lang="liva">
motion motion(checked: boolean) {
  state off { box { background-color: red } }
  state on when checked { box { background-color: blue } }
  transition { @tween: 50ms }
}
</liva>
