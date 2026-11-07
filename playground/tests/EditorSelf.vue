<script setup lang="ts">
import { ref } from 'vue'

const active = ref(false)
</script>

<template>
  <button
    v-liva:rooted="{ active }"
    aria-label="Self fixture"
    :aria-pressed="active"
    @click="active = !active"
  >
    <span v-liva-target:icon>Root target</span>
  </button>
</template>

<liva lang="liva">
motion rooted(active: boolean) {
  @tween(duration: 400, easing: linear)
  layer selection {
    opacity: 1
    @tween(duration: 200, easing: linear)
    self { scale: 1 }
    icon { rotate: 0deg }

    state off initial {}
    state on {
      opacity: .5
      self { scale: 1.5 }
      icon { rotate: 45deg }
    }

    @tween(duration: 400, easing: linear)
    transition off -> on when active {
      opacity ~> {}
      @tween(duration: 200, easing: linear)
      self { scale ~> {} }
    }
    transition on -> off when !active
  }

  @tween(duration: 400, easing: linear)
  enter {
    opacity: 0
    @tween(duration: 200, easing: linear)
    self { scale: .8 }
  }

  @tween(duration: 400, easing: linear)
  leave {
    opacity: 0
    @tween(duration: 200, easing: linear)
    self { scale: .8 }
  }
}
</liva>
