<script lang="ts">
import { defineComponent } from 'vue'
import { presenceComponents } from './presence-registry.ts'

export default defineComponent({
  components: presenceComponents,
})
</script>

<script setup lang="ts">
import { ref, type VNode } from 'vue'
import { registeredName } from './presence-registry.ts'

const visible = ref(true)
const rowProps = {
  title: 'Authored attributes',
  onVnodeBeforeMount(vnode: VNode) {
    if (vnode.el instanceof HTMLElement) vnode.el.dataset.authoredMount = 'true'
  },
}
</script>

<template>
  <main>
    <h1>Presence with an imported registry</h1>
    <component :is="registeredName" />
    <button @click="visible = !visible">Remove first item</button>
    <ul>
      <li v-if="visible" v-liva:departure v-bind="rowProps">
        First item
      </li>
      <li>Second item</li>
    </ul>
  </main>
</template>

<liva lang="liva">
motion departure {
  layer base { opacity: 1 }
  @tween(duration: 400, easing: linear)
  leave { opacity: 0 }
}
</liva>
