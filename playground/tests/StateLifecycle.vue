<script setup lang="ts">
import { ref } from 'vue'

const open = ref(true)
const visible = ref(true)
const shown = ref(true)
const distance = ref(40)
</script>

<template>
  <button id="toggle-state" @click="open = !open">Toggle state</button>
  <button id="remove" @click="visible = !visible">Toggle insertion</button>
  <button id="hide" @click="shown = !shown">Toggle visibility</button>
  <button id="distance" @click="distance = 90">Change distance</button>
  <div v-if="visible" v-liva:panel="{ open, distance }" v-liva-target:content id="card">
    Card <span v-liva-target:badge id="badge">Badge</span>
  </div>
  <div v-show="shown" v-liva:panel="{ open, distance }" v-liva-target:content id="shown-card">
    Shown card <span v-liva-target:badge>Badge</span>
  </div>
</template>

<liva>
motion panel(open: boolean, distance: number) {
  state closed {
    content { opacity: 1; scale: 0.9; translate: 0px 0 }
    badge { opacity: 1 }
  }
  state opened when open { content { scale: 1 } }
  transition { @tween: 1000ms }
  enter {
    @tween: 1000ms linear
    content { opacity: 0 }
  }
  enter opened {
    @tween: 2000ms linear
    content { scale: 0.8; translate: ${distance}px 0 }
    badge { opacity: 0 }
  }
  leave {
    @tween: 1000ms linear
    content { opacity: 0 }
  }
  leave opened {
    content { scale: 1.2; translate: ${distance}px 0 }
    badge { opacity: 0 }
  }
}
</liva>
