<template>
  <section aria-labelledby="drag-title" class="demo">
    <h1 id="drag-title">Drag</h1>
    <div class="demo-stage">
      <div v-liva:card="{}" v-liva-target:body class="draggable-card" data-testid="draggable-card">
        <span aria-hidden="true">↗</span>
        <strong>Drag me</strong>
      </div>
    </div>
  </section>
</template>

<style scoped>
.draggable-card {
  inline-size: 220px;
  max-inline-size: 100%;
  padding: 2rem;
  border-radius: 24px;
  background: #e0eddf;
  color: #183d31;
  box-shadow: 0 12px 40px #173e3020;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.draggable-card:active {
  cursor: grabbing;
}
.draggable-card span {
  display: block;
  font-size: 2rem;
  margin-block-end: 1rem;
}
</style>

<liva lang="liva">
motion card {
  let movement = drag(target: body)

  layer base {
    @spring(stiffness: 300, damping: 20)
    body {
      translate: 0 0
      scale: 1
    }
  }

  layer dragging when movement.active {
    body {
      translate: ${movement.offset.x}px ${movement.offset.y}px @tween(duration: 0)
      scale: 1.05
    }
  }
}
</liva>
