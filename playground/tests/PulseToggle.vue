<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ label: string }>()
const checked = ref(false)
</script>

<template>
  <div class="toggle-row">
    <strong>{{ label }}</strong>
    <button
      v-liva:toggle="{ checked }"
      v-liva-target:track
      role="switch"
      :aria-label="label"
      :aria-checked="checked"
      class="switch"
      @click="checked = !checked"
    >
      <span v-liva-target:thumb class="thumb" />
    </button>
  </div>
</template>

<liva lang="liva">
motion toggle(checked: boolean) {
  @tween(duration: 350, easing: easeOut)
  layer toggle {
    track { background-color: #888 @tween(duration: 200, easing: easeInOut) }
    thumb { translate: 0 0 @spring(stiffness: 300, damping: 20); scale: 1 }

    state off initial {}
    state on {
      track { background-color: #34b27b }
      thumb { translate: 24px 0 }
    }

    transition off -> on when checked {
      thumb { scale ~> { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut } }
    }
    transition on -> off when !(checked) {
      thumb {
        @spring(duration: 350, bounce: 0.2)
        translate ~> {}
        scale ~> { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut }
      }
    }
  }
}
</liva>
