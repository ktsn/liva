<script setup lang="ts">
import { ref } from 'vue'
import Toggle from '../Toggle.vue'

const visible = ref(true)
</script>

<template>
  <section aria-labelledby="toggle-title" class="demo">
    <h1 id="toggle-title">Toggle</h1>
    <div class="demo-card">
      <template v-if="visible">
        <Toggle label="Notifications" />
        <Toggle label="Product updates" />
      </template>
      <button class="text-button" @click="visible = !visible">
        {{ visible ? 'Unmount switches' : 'Mount switches' }}
      </button>
    </div>
  </section>
</template>
