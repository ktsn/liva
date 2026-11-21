<script setup lang="ts">
import { ref } from 'vue'

const visible = ref(true)
const count = ref(0)
</script>

<template>
  <main title="Before edit">
    <h1>Presence during template HMR</h1>
    <button @click="count++">Count {{ count }}</button>
    <button @click="visible = !visible">Remove first item</button>
    <ul>
      <li v-if="visible" v-liva:departure>First item</li>
      <li>Second item</li>
    </ul>
  </main>
</template>

<liva lang="liva">
motion departure {
  layer base { opacity: 1 }
  @tween(duration: 400, easing: linear)
  leave { opacity: 0 }
}
</liva>
