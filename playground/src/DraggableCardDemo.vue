<template>
  <section class="drag-demo">
    <h2>Move a little. Come back.</h2>
    <p>Drag the card and release it to feel the spring.</p>
    <div v-liva:card="{}" v-liva-target:body class="draggable-card" data-testid="draggable-card">
      <span>↗</span>
      <strong>Room to move</strong>
      <p>Grab, move, release.</p>
    </div>
  </section>
</template>

<liva>
motion card {
  source movement = drag(target: body)

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
.drag-demo {
  padding: 2rem 0 4rem;
}
.draggable-card {
  margin: 2rem auto;
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
