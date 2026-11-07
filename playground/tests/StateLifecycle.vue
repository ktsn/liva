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
  <div v-if="visible" id="card" v-liva:panel="{ open, distance }" v-liva-target:content>
    Card <span id="badge" v-liva-target:badge>Badge</span>
  </div>
  <div v-show="shown" id="shown-card" v-liva:panel="{ open, distance }" v-liva-target:content>
    Shown card <span v-liva-target:badge>Badge</span>
  </div>
</template>

<liva lang="liva">
motion panel(open: boolean, distance: number) {
  layer base {
    content {
      opacity: 1
      translate: 0px 0
      border-radius: 0px
    }

    badge {
      opacity: 1
    }
  }

  layer opened when open {
    content {
      border-radius: 20px
    }
  }

  layer sizing {
    state closed initial {
      content {
        scale: 0.9
      }
    }

    state opened {
      content {
        scale: 1
      }
    }

    transition closed -> opened when open
    transition opened -> closed when !open
  }

  enter {
    @tween(duration: 2000, easing: linear)
    content {
      opacity: 0
      scale: 0.8
      translate: ${distance}px 0
    }

    @tween(duration: 2000, easing: linear)
    badge {
      opacity: 0
    }
  }

  leave {
    @tween(duration: 1000, easing: linear)
    content {
      opacity: 0
      scale: 1.2
      translate: ${distance}px 0
    }

    @tween(duration: 1000, easing: linear)
    badge {
      opacity: 0
    }
  }
}
</liva>
