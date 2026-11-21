<script setup lang="ts">
import { ref } from 'vue'

const visible = ref(true)
const $options = { heading: 'Presence with an authored block attribute' }
</script>

<template>
  <main>
    <h1>{{ $options.heading }}</h1>
    <button @click="visible = !visible">Remove first item</button>
    <ul>
      <li v-if="visible" v-liva:departure>First item</li>
      <li>Second item</li>
    </ul>
  </main>
</template>

<liva lang="liva" liva-presence-index="4">
motion departure {
  layer base { opacity: 1 }
  @tween(duration: 400, easing: linear)
  leave { opacity: 0 }
}
</liva>
