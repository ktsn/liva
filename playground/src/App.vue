<script setup lang="ts">
import { ref } from 'vue'
import Toggle from './Toggle.vue'
const visible = ref(true)
const active = ref(false)
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
    <section class="demo-card" aria-label="Animation playground">
      <div class="card-heading">
        <div>
          <span class="eyebrow">01 / Shared definition</span>
          <h2>Your preferences</h2>
        </div>
        <span class="status-dot">Live</span>
      </div>
      <template v-if="visible"
        ><Toggle label="Notifications" /><Toggle label="Product updates"
      /></template>
      <div class="card-footer">
        <span>One definition. Two independent instances.</span
        ><button class="text-button" @click="visible = !visible">
          {{ visible ? 'Unmount switches' : 'Mount switches' }}
        </button>
      </div>
    </section>
    <section class="secondary">
      <div>
        <p class="eyebrow">02 / Another definition</p>
        <h2>A quieter pulse</h2>
        <p>A separate motion identity, on the same page.</p>
      </div>
      <button
        v-liva:beacon="active ? 'on' : 'off'"
        v-liva-target:light
        class="beacon"
        :aria-pressed="active"
        @click="active = !active"
      >
        {{ active ? 'Active' : 'Activate' }}
      </button>
    </section>
    <footer>
      <span>Designed in source. Experienced in the browser.</span><span>LIVA / MVP</span>
    </footer>
  </main>
</template>

<liva>
beacon {
  state off { light { opacity: 0.5; scale: 1 } }
  state on { light { opacity: 1; scale: 1.04 } }
  transition { timing: tween(duration: 450ms, easing: ease-in-out) }
}
</liva>

<style src="./style.css"></style>
