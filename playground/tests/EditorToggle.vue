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
  @tween(duration: 50) layer selection {
    state off initial { box { background-color: red } }
    state on { box { background-color: blue } }
    transition off -> on when checked
    transition on -> off when !checked
  }
}
</liva>
