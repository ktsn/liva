<script setup lang="ts">
import { ref } from 'vue'
const active = ref(false)
</script>
<template>
  <button v-liva:hmr="active ? 'on' : 'off'" v-liva-target:box @click="active = !active">
    HMR {{ active }}
  </button>
</template>
<liva>
hmr {
  state off { box { background-color: red } }
  state on { box { background-color: blue } }
  transition { timing: tween(duration: 50ms) }
}
</liva>
