<script setup lang="ts">
import { ref } from 'vue'
const active = ref(false)
</script>

<template>
  <button v-liva:hmr="{ active }" v-liva-target:box @click="active = !active">
    HMR {{ active }}
  </button>
</template>

<liva lang="liva">
motion hmr(active: boolean) {
  layer selection @tween(duration: 50) {
    state off initial { box { background-color: red } }
    state on { box { background-color: blue } }
    transition off -> on when active
    transition on -> off when !active
  }
}
</liva>
