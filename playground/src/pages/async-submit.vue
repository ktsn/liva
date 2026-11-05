<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'

const busy = ref(false)
const completed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function submit() {
  completed.value = false
  busy.value = true
  timer = setTimeout(() => {
    busy.value = false
    completed.value = true
  }, 800)
}

onScopeDispose(() => clearTimeout(timer))
</script>

<template>
  <section class="demo">
    <h1>Async submit</h1>
    <p>Vue owns the simulated request; a layer animates its presentation states.</p>
    <button
      v-liva:submit="{ busy, completed }"
      v-liva-target:body
      :disabled="busy"
      data-testid="submit"
      @click="submit"
    >
      {{ busy ? 'Submitting…' : completed ? 'Submit again' : 'Submit' }}
    </button>
    <p role="status">{{ completed ? 'Saved' : busy ? 'Saving…' : 'Ready' }}</p>
  </section>
</template>

<liva>
motion submit(busy: boolean, completed: boolean) {
  layer request {
    body @tween(duration: 240, easing: easeOut) { scale: 1; opacity: 1; background-color: #d9f3e8 }
    state idle initial {}
    state pending { body { opacity: 0.6 } }
    state success { body { background-color: #64c69e } }

    transition idle -> pending when busy
    transition success -> pending when busy
    transition pending -> success when completed {
      body { scale @tween(duration: 300) { 50%: 1.15 } }
    }
    transition pending -> idle when !busy && !completed
  }
}
</liva>
