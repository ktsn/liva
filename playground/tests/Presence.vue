<script setup lang="ts">
import { defineComponent, h, onUnmounted, ref } from 'vue'
const UnmountProbe = defineComponent({
  setup() {
    onUnmounted(() => document.dispatchEvent(new CustomEvent('probe-unmounted')))
    return () => h('span', { id: 'probe' }, 'Probe')
  },
})
const visible = ref(true)
const shown = ref(true)
const branch = ref(0)
const items = ref([1, 2])
const rootVisible = ref(true)
const innerVisible = ref(true)
</script>

<template>
  <button id="toggle" @click="visible = !visible">Toggle</button>
  <button id="show" @click="shown = !shown">Show</button>
  <button id="branch" @click="branch = (branch + 1) % 3">Branch</button>
  <button id="root-toggle" @click="rootVisible = !rootVisible">Root</button>
  <button id="inner-toggle" @click="innerVisible = !innerVisible">Inner</button>
  <button id="remove" @click="items = items.slice(1)">Remove</button>
  <div v-liva:panel>
    <section v-if="visible" id="ancestor">
      <UnmountProbe />
      <div v-liva-target:content id="content">Content</div>
      <div v-liva-target:secondary id="secondary">Secondary</div>
      <div v-if="innerVisible" v-liva:nested v-liva-target:body id="nested">Nested</div>
    </section>
    <div v-if="visible" v-liva-target:direct id="direct">Direct</div>
    <div v-show="shown" v-liva-target:directVisibility id="direct-visibility">
      Direct visibility
    </div>
    <div v-for="item in items" :key="item" v-liva-target:repeated :id="'repeated-' + item">
      Repeated target
    </div>
    <section v-show="shown" id="show-ancestor">
      <div v-liva-target:visibility id="visibility">Visibility</div>
    </section>
    <div v-if="branch === 0" v-liva-target:first id="first">First</div>
    <section v-else-if="branch === 1" id="second">
      <div v-liva-target:second>Second</div>
    </section>
    <section v-else id="third">
      <div v-liva-target:third>Third</div>
    </section>
  </div>
  <div v-if="rootVisible" v-liva:nested v-liva-target:body id="motion-root">Root</div>
  <section v-for="item in items" :key="item" :id="'row-' + item">
    <div v-liva:nested v-liva-target:body :id="'row-body-' + item">Row</div>
  </section>
</template>

<style scoped>
#content,
#visibility {
  color: rgb(12, 34, 56);
}
</style>

<liva>
motion panel {
  state idle {
    direct { opacity: 1 }
    directVisibility { opacity: 1 }
    repeated { opacity: 0.8 }
    content { opacity: 1 }
    secondary { opacity: 1 }
    visibility { opacity: 1 }
    first { opacity: 1 }
    second { opacity: 1 }
    third { opacity: 1 }
  }
  enter {
    @tween: 100ms
    direct { opacity { 0%: 0 } }
    directVisibility { opacity { 0%: 0 } }
    content { opacity { 0%: 0 } }
    secondary { opacity { 0%: 0 } }
    visibility { opacity { 0%: 0 } }
    first { opacity { 0%: 0 } }
    second { opacity { 0%: 0 } }
    third { opacity { 0%: 0 } }
  }
  leave {
    @tween: 300ms
    direct { opacity { 100%: 0 } }
    directVisibility { opacity { 100%: 0 } }
    repeated { opacity { 100%: 0 } }
    content { opacity { 100%: 0 } }
    secondary { opacity { @tween: 500ms; 100%: 0 } }
    visibility { opacity { 100%: 0 } }
    first { opacity { 100%: 0 } }
    second { opacity { 100%: 0 } }
    third { opacity { 100%: 0 } }
  }
}
motion nested {
  state idle { body { opacity: 1 } }
  leave {
    @tween: 400ms
    body { opacity { 100%: 0 } }
  }
}
</liva>
