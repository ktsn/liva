<script setup lang="ts">
import { ref, type VNode } from 'vue'

const visible = ref(true)
const rows = [
  {
    id: 'authored-row',
    props: {
      title: 'Scoped value',
      onVnodeBeforeMount(vnode: VNode) {
        if (vnode.el instanceof HTMLElement) vnode.el.dataset.authoredMount = 'true'
      },
    },
  },
]
</script>

<template>
  <main>
    <h1>Presence in authored template scope</h1>
    <button @click="visible = !visible">{{ visible ? 'Hide item' : 'Show item' }}</button>
    <ul v-for="$options in rows" :key="$options.id">
      <li v-show="visible" v-liva:departure v-bind="$options.props">First item</li>
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
