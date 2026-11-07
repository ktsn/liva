<script setup lang="ts">
import { ref } from 'vue'

const active = ref(false)
</script>

<template>
  <section aria-labelledby="beacon-title" class="demo">
    <h1 id="beacon-title">Beacon</h1>
    <div class="demo-stage">
      <button
        v-liva:beacon="{ checked: active }"
        v-liva-target:light
        class="beacon"
        :aria-pressed="active"
        @click="active = !active"
      >
        {{ active ? 'Active' : 'Activate' }}
      </button>
    </div>
  </section>
</template>

<liva lang="liva">
motion beacon(checked: boolean) {
  @tween(duration: 450, easing: easeInOut)
  layer base {
    light { opacity: 0.5; scale: 1 }
  }
  layer active when checked { light { opacity: 1; scale: 1.04 } }
}
</liva>
