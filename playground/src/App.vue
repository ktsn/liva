<script setup lang="ts">
import ToggleDemo from './ToggleDemo.vue'
import BeaconDemo from './BeaconDemo.vue'
import DraggableCardDemo from './DraggableCardDemo.vue'
</script>

<template>
  <main>
    <header>
      <a class="wordmark" href="/">liva<span> / playground</span></a
      ><span class="tag">Motion, in context</span>
    </header>
    <section class="intro">
      <p class="eyebrow">A small language for living interfaces</p>
      <h1>Make the change<br /><em>feel right.</em></h1>
      <p class="lead">
        Real components. Shared animation. Independent moments.<br />Try the switches, reverse them
        mid-flight, and explore their motion.
      </p>
    </section>
    <ToggleDemo />
    <BeaconDemo />
    <DraggableCardDemo />
    <footer>
      <span>Designed in source. Experienced in the browser.</span><span>LIVA / MVP</span>
    </footer>
  </main>
</template>

<style src="./style.css"></style>
