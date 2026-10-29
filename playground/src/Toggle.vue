<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ label: string }>()
const checked = ref(false)
</script>

<template>
  <div class="toggle-row">
    <div>
      <strong>{{ label }}</strong>
      <p>{{ checked ? 'On · keeping you connected' : 'Off · a little more quiet' }}</p>
    </div>
    <button
      v-liva:toggle="{ checked }"
      v-liva-target:track
      role="switch"
      :aria-label="label"
      :aria-checked="checked"
      @click="checked = !checked"
      class="switch"
    >
      <span v-liva-target:thumb class="thumb" />
    </button>
  </div>
</template>

<liva>
toggle {
  source checked = external(type: Boolean)
  state off {
    track {
      background-color: #888
    }

    thumb {
      translate: 0 0
      scale: 1
    }
  }

  state on when checked {
    track {
      background-color: #34b27b
    }

    thumb {
      translate: 24px 0
      scale: 1
    }
  }

  transition {
    @tween: 350ms ease-out

    track {
      background-color {
        @tween-duration: 200ms
        @tween-easing: ease-in-out
      }
    }

    thumb {
      translate {
        @spring: 300 20 1
      }

      scale {
        40%: 1.3 1 @ ease-in
        70%: 0.95 1 @ ease-out
      }
    }
  }

  transition on -> off {
    thumb {
      translate {
        @spring: 350ms 0.2
      }
    }
  }
}
</liva>
