<script setup lang="ts">
import { ref } from 'vue'
const outer = ref(false)
const inner = ref(false)
const visible = ref(true)
const child = ref(true)
</script>
<template>
  <button @click="visible = !visible">Mount</button>
  <button @click="child = !child">Target</button>
  <button @click="outer = !outer">Outer</button>
  <button @click="inner = !inner">Inner</button>
  <div v-if="visible" id="outer" v-liva:a="outer ? 'on' : 'off'" v-liva-target:track>
    <span v-if="child" id="outer-thumb" v-liva-target:thumb>outer</span>
    <div id="inner" v-liva:a="inner ? 'on' : 'off'" v-liva-target:track>
      <span id="inner-thumb" v-liva-target:thumb>inner</span>
    </div>
  </div>
</template>
<style>
span {
  display: inline-block;
}
</style>
<liva lang="liva">
motion a {
  state off { track { opacity: 0.5 } thumb { translate: 0px } }
  state on when true { track { opacity: 1 } thumb { translate: 20px } }
  transition { timing: tween(duration: 200ms) }
}
</liva>
