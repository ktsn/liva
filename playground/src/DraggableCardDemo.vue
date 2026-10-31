<template>
  <section class="demo" aria-labelledby="drag-title">
    <h1 id="drag-title">Drag</h1>
    <div class="demo-stage">
      <div v-liva:card="{}" v-liva-target:body class="draggable-card" data-testid="draggable-card">
        <span aria-hidden="true">↗</span>
        <strong>Drag me</strong>
      </div>
    </div>
  </section>
</template>

<liva lang="liva">
motion card {
  let movement = drag(target: body)

  state idle {
    body {
      translate: 0 0
      scale: 1
    }
  }

  state dragging when movement.active {
    body {
      translate: ${movement.offset.x}px ${movement.offset.y}px
      scale: 1.05
    }
  }

  transition {
    @tween: 200ms ease-out
  }

  transition dragging -> idle {
    body {
      translate {
        @spring: 300 20 1
      }

      scale {
        @tween: 180ms ease-out
      }
    }
  }
}
</liva>

<style scoped>
.draggable-card {
  width: 220px;
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
  margin-bottom: 1rem;
}
</style>
