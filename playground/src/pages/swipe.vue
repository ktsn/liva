<script setup lang="ts">
import { ref } from 'vue'

const initialItems = [
  { id: 1, title: 'Item A' },
  { id: 2, title: 'Item B' },
  { id: 3, title: 'Item C' },
]
const items = ref([...initialItems])

function resetItems() {
  items.value = initialItems
}

function removeItem(id: number) {
  items.value = items.value.filter((item) => item.id !== id)
}
</script>

<template>
  <section class="demo">
    <h1>Swipe to dismiss</h1>
    <p>Drag a card more than 120 pixels to the right, then release.</p>
    <button type="button" @click="resetItems">Reset cards</button>
    <p data-testid="item-count">{{ items.length }} items</p>
    <div
      v-for="item in items"
      :key="item.id"
      v-liva:swipeItem
      v-liva-target:body
      class="swipe-card"
      :data-testid="'swipe-' + item.id"
      @liva-dismiss="removeItem(item.id)"
    >
      {{ item.title }}
      <button @pointerdown.stop @click="removeItem(item.id)">Dismiss</button>
    </div>
  </section>
</template>

<style scoped>
.swipe-card {
  display: flex;
  justify-content: space-between;
  padding: 2rem;
  margin-block: 1rem;
  border-radius: 1rem;
  background: #d9f3e8;
  color: #16362a;
  touch-action: none;
  user-select: none;
}
</style>

<liva lang="liva">
motion swipeItem {
  let movement = drag(target: body)

  event dismiss when movement.released && movement.offset.x > 120

  layer base {
    @spring(stiffness: 300, damping: 20)
    body {
      translate: 0 0
      opacity: 1
    }
  }

  layer dragging when movement.active {
    body {
      translate: ${movement.offset.x}px 0 @tween(duration: 0)
    }
  }

  enter {
    @tween(duration: 350, easing: easeOut)
    body {
      opacity: 0
      translate: 0 -20px
    }
  }

  leave {
    @tween(duration: 250, easing: easeOut)
    body {
      translate: 500px 0
      opacity: 0
    }
  }
}
</liva>
