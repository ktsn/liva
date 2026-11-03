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
  <section class="swipe-demo">
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
.swipe-demo {
  max-width: 38rem;
  margin: 3rem auto;
}
.swipe-card {
  display: flex;
  justify-content: space-between;
  padding: 2rem;
  margin: 1rem 0;
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

  event dismiss when movement.released
    && movement.offset.x > 120

  state idle {
    body {
      translate: 0 0
      opacity: 1
    }
  }

  state dragging when movement.active {
    body {
      translate: ${movement.offset.x}px 0
    }
  }

  transition dragging -> idle {
    body {
      translate {
        @spring: 300 20 1
      }
    }
  }

  enter {
    @tween: 350ms ease-out

    body {
      opacity: 0
      translate: 0 -20px
    }
  }

  leave {
    @tween: 250ms ease-out
    body {
      translate: 500px 0
      opacity: 0
    }
  }
}
</liva>
