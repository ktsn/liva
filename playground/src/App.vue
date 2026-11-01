<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <main>
    <header>
      <RouterLink class="wordmark" to="/toggle">liva<span> / playground</span></RouterLink>
      <nav aria-label="Demos">
        <RouterLink to="/toggle">Toggle</RouterLink>
        <RouterLink to="/beacon">Beacon</RouterLink>
        <RouterLink to="/drag">Drag</RouterLink>
        <RouterLink to="/swipe">Swipe</RouterLink>
      </nav>
    </header>
    <RouterView />
  </main>
</template>

<style src="./style.css"></style>
