<script setup lang="ts">
import { ref } from 'vue'

const selected = ref(false)
const disabled = ref(false)
</script>

<template>
  <section class="demo">
    <h1>Interactive button</h1>
    <p>Press wins over hover for scale. Selection keeps its color during either interaction.</p>
    <button
      v-liva:button="{ selected, disabled }"
      :disabled="disabled"
      :aria-pressed="selected"
      data-testid="interactive-button"
      @click="selected = !selected"
    >Press me</button>
    <label class="disable-control">
      <input v-model="disabled" type="checkbox" />
      Disable button
    </label>
  </section>
</template>

<style scoped>
.disable-control {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block-start: 24px;
}
</style>

<liva lang="liva">
motion button(selected: boolean, disabled: boolean) {
  let ui = interaction(target: self)

  @tween(duration: 180, easing: easeOut)
  layer base {
    scale: 1
    background-color: #d9f3e8
    box-shadow: 0 0 0 0px #16795b
    opacity: 1
  }

  layer hover when ui.hover && !disabled {
    scale: 1.08
    background-color: #b5e4d1
  }

  layer selected when selected {
    background-color: #64c69e
  }

  layer focus when ui.focusVisible {
    box-shadow: 0 0 0 4px #16795b
  }

  layer press when ui.active && !disabled {
    scale: 0.94
  }

  layer disabled when disabled {
    scale: 1
    background-color: #d3d8d5
    opacity: 0.55
  }
}
</liva>
