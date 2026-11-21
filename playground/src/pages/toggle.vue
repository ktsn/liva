<script setup lang="ts">
import Toggle from '../components/Toggle.vue'
</script>

<template>
  <div class="switches">
    <Toggle label="Notifications" />
    <Toggle initial-checked label="Product updates" />
  </div>
</template>

<style scoped>
.switches {
  display: flex;
  align-items: center;
  gap: 24px;
}
</style>
