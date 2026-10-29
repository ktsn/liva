<script setup lang="ts">
import { ref } from 'vue'

const active = ref(false)
</script>

<template>
  <section class="secondary">
    <div>
      <p class="eyebrow">02 / Another definition</p>
      <h2>A quieter pulse</h2>
      <p>A separate motion identity, on the same page.</p>
    </div>
    <button
      v-liva:beacon="{ checked: active }"
      v-liva-target:light
      class="beacon"
      :aria-pressed="active"
      @click="active = !active"
    >
      {{ active ? 'Active' : 'Activate' }}
    </button>
  </section>
</template>

<liva>
beacon {
  source checked = external(type: Boolean)
  state off { light { opacity: 0.5; scale: 1 } }
  state on when checked { light { opacity: 1; scale: 1.04 } }
  transition { @tween: 450ms ease-in-out }
}
</liva>
