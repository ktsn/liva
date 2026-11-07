<script setup lang="ts">
import { ref } from 'vue'

const { label, initialChecked = false } = defineProps<{ label: string; initialChecked?: boolean }>()

const checked = ref(initialChecked)
</script>

<template>
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
</template>

<liva lang="liva">
motion toggle(checked: boolean) {
  layer base {
    @tween(duration: 200, easing: easeInOut) track {
      background-color: #888
    }

    @spring(stiffness: 300, damping: 20) thumb {
      translate: 0 0
      scale: 1
    }
  }

  layer selection when checked {
    track {
      background-color: #34b27b
    }

    thumb {
      translate: 24px 0
    }
  }
}
</liva>
