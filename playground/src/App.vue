<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="playground">
    <aside class="sidebar">
      <RouterLink class="wordmark" to="/toggle">
        liva<span class="wordmark-caption">playground</span>
      </RouterLink>
      <nav aria-label="Demos" class="demo-nav">
        <RouterLink class="demo-link" to="/toggle">Toggle</RouterLink>
        <RouterLink class="demo-link" to="/beacon">Beacon</RouterLink>
        <RouterLink class="demo-link" to="/drag">Drag</RouterLink>
        <RouterLink class="demo-link" to="/swipe">Swipe</RouterLink>
      </nav>
    </aside>
    <main class="demo-content">
      <RouterView />
    </main>
  </div>
</template>

<style src="./style.css"></style>
