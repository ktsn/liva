<script setup lang="ts">
import { ref } from 'vue'
import Toggle from './Toggle.vue'

const visible = ref(true)
</script>

<template>
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
</template>
