<script setup lang="ts">
import { computed, ref } from 'vue'

const hovered = ref(false)
const pointerPressed = ref(false)
const keyboardPressed = ref(false)
const pressed = computed(() => pointerPressed.value || keyboardPressed.value)
const focused = ref(false)
</script>

<template>
  <section class="demo">
    <h1>Interactive button</h1>
    <p>Hover, focus, and press can contribute independently. Press wins for scale.</p>
    <button
      v-liva:button="{ hovered, pressed, focused }"
      v-liva-target:body
      data-testid="interactive-button"
      @pointerenter="hovered = true"
      @pointerleave="hovered = false; pointerPressed = false"
      @pointerdown="pointerPressed = true"
      @pointerup="pointerPressed = false"
      @pointercancel="pointerPressed = false"
      @focus="focused = true"
      @blur="focused = false; keyboardPressed = false"
      @keydown.space="keyboardPressed = true"
      @keyup.space="keyboardPressed = false"
      @keydown.enter="keyboardPressed = true"
      @keyup.enter="keyboardPressed = false"
    >Press me</button>
  </section>
</template>

<liva>
motion button(hovered: boolean, pressed: boolean, focused: boolean) {
  layer base {
    body @tween(duration: 180, easing: easeOut) {
      scale: 1
      background-color: #d9f3e8
      box-shadow: 0 0 0 0px #16795b
    }
  }

  layer hover when hovered { body { scale: 1.08; background-color: #b5e4d1 } }
  layer focus when focused { body { box-shadow: 0 0 0 4px #16795b } }
  layer press when pressed { body { scale: 0.94 } }
}
</liva>
