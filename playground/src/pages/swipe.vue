<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'

const initialItems = [
  { id: 1, title: 'Item A' },
  { id: 2, title: 'Item B' },
  { id: 3, title: 'Item C' },
]
const items = ref([...initialItems])
const activeRow = ref<number>()

function outsideInteraction(event: PointerEvent) {
  const row = event.target instanceof Element ? event.target.closest('[data-swipe-id]') : null
  const id = row?.getAttribute('data-swipe-id')
  activeRow.value = id === null || id === undefined ? undefined : Number(id)
}

onMounted(() => document.addEventListener('pointerdown', outsideInteraction, true))
onScopeDispose(() => document.removeEventListener('pointerdown', outsideInteraction, true))

function resetItems() {
  items.value = initialItems
}

function removeItem(id: number) {
  items.value = items.value.filter((item) => item.id !== id)
}
</script>

<template>
  <section class="demo">
    <h1>Swipe actions</h1>
    <p
    >Swipe right to reveal Delete. Release velocity chooses open or closed; a drag beyond 120 pixels dismisses immediately. Press outside a row to close it.</p>
    <button type="button" @click="resetItems">Reset cards</button>
    <p data-testid="item-count">{{ items.length }} items</p>
    <ul class="swipe-list">
      <li
        v-for="item in items"
        :key="item.id"
        v-liva:swipeItem="{ outside: activeRow !== item.id }"
        class="swipe-card"
        :data-swipe-id="item.id"
        :data-testid="'swipe-' + item.id"
        @liva-dismiss="removeItem(item.id)"
      >
        <button
          class="swipe-action"
          :aria-label="'Delete ' + item.title"
          @click="removeItem(item.id)"
        >Delete</button>
        <div v-liva-target:body class="swipe-face">
          {{ item.title }}
          <button @pointerdown.stop @click="removeItem(item.id)">Dismiss</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.swipe-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.swipe-card {
  position: relative;
  margin-block: 1rem;
  border-radius: 1rem;
  overflow: clip;
}

.swipe-action {
  position: absolute;
  inset-inline-start: 0;
  inset-block: 0;
  inline-size: 96px;
  border: 0;
  margin: 0;
  padding: 0.5rem;
  background: #c44343;
  color: white;

  &:focus-visible {
    z-index: 2;
    outline-offset: -4px;
  }
}

.swipe-face {
  position: relative;
  display: flex;
  justify-content: space-between;
  padding: 2rem;
  border-radius: 1rem;
  background: #d9f3e8;
  color: #16362a;
  touch-action: pan-y;
  user-select: none;
}
</style>

<liva lang="liva">
motion swipeItem(outside: boolean) {
  let pointer = drag(target: body)
  let movement = link(input: pointer.offset.x, component: "x")
  let projectedX = movement.value.x + movement.velocity.x * 200

  event dismiss when pointer.released && pointer.offset.x > 120

  @spring(stiffness: 300, damping: 25)
  layer position {
    opacity: 1
    translate: 0 0
    body { translate: 0 0 }

    state closed initial {}
    state open { body { translate: 96px 0 } }
    state dismissed { body { translate: 500px 0 } }

    on pointer.release {
      transition closed -> open when pointer.offset.x <= 120 && projectedX >= 48
      transition open -> closed when pointer.offset.x <= 120 && projectedX < 48
      transition closed -> dismissed when pointer.offset.x > 120
      transition open -> dismissed when pointer.offset.x > 120
    }

    transition open -> closed when outside
  }

  layer dragging when pointer.active {
    body { translate := movement }
  }

  @tween(duration: 350, easing: easeOut)
  enter {
    opacity: 0
    translate: 0 -20px
  }

  @tween(duration: 250, easing: easeOut)
  leave {
    translate: 500px 0
    opacity: 0
    body { translate: 500px 0 }
  }
}
</liva>
