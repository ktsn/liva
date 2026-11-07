<script setup lang="ts">
import Toggle from '../Toggle.vue'
</script>

<template>
  <div class="switches">
    <Toggle label="Notifications" />
    <Toggle label="Product updates" initial-checked />
  </div>
</template>

<style scoped>
.switches {
  display: flex;
  align-items: center;
  gap: 24px;
}
</style>
