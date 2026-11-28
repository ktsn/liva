<script lang="ts">
import { defineComponent, h } from 'vue'

export default defineComponent({
  components: {
    LivaPresenceBoundary: defineComponent({
      setup() {
        return () => h('p', 'Authored component')
      },
    }),
  },
  directives: {
    livaEntry: {
      mounted(element: HTMLElement) {
        element.dataset.authored = 'true'
      },
    },
  },
})
</script>

<script setup lang="ts">
import { ref } from 'vue'

const LivaCompiledPresenceBoundary = defineComponent({
  setup() {
    return () => h('p', 'Authored setup component')
  },
})
const vLivaCompiledEntry = {
  mounted(element: HTMLElement) {
    element.dataset.authored = 'true'
  },
}

const departing = ref(true)
</script>

<template>
  <LivaPresenceBoundary v-liva-entry data-testid="authored-presence" />
  <LivaCompiledPresenceBoundary v-liva-compiled-entry data-testid="authored-setup-presence" />
  <button type="button" @click="departing = !departing">
    {{ departing ? 'Remove first item' : 'Restore first item' }}
  </button>
  <ul aria-label="Items">
    <li v-if="departing" v-liva:departure data-testid="departing">First item</li>
    <li v-liva:position data-testid="survivor">Second item</li>
  </ul>
</template>

<style scoped>
li {
  box-sizing: border-box;
  block-size: 48px;
  inline-size: 220px;
  padding: 0.75em;
  margin-block: 4px;
  background: #d9f3e8;
}
</style>

<liva lang="liva">
motion departure {
  layer base { opacity: 1 }
  @tween(duration: 400, easing: linear)
  leave { opacity: 0 }
}

motion position {
  @tween(duration: 700, easing: linear)
  layer base { $layout: position }
}
</liva>
