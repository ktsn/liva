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
  layer base {
    track @tween(duration: 200, easing: easeInOut) {
      background-color: #888
    }

    thumb @spring(stiffness: 300, damping: 20) {
      translate: 0 0
      scale: 1
    }
  }

  layer selection {
    state off initial {
      thumb {
        scale: 1
      }
    }

    state on {
      track {
        background-color: #34b27b
      }

      thumb {
        translate: 24px 0
        scale: 1
      }
    }

    transition off -> on when checked {
      thumb {
        scale @tween(duration: 350) {
          40%: 1.3 1 @easeIn
          70%: 0.95 1 @easeOut
        }
      }
    }

    transition on -> off when !checked {
      thumb {
        translate @spring(stiffness: 350, damping: 22) {
        }
      }
    }
  }
}
</liva>
