<script setup lang="ts">
import { ref } from 'vue'
import TopicCard from '../components/TopicCard.vue'

const topics = ref([
  {
    id: 'garden',
    category: 'Make room',
    title: 'A garden in a small space',
    summary: 'Start with a sunny corner and something you like to cook.',
    details: [
      'A few pots can make a balcony feel like a garden. Choose herbs you use often, leave room for watering, and notice how the light moves through the day.',
      'The card takes its natural height from this text. Open another topic, move this one, or change your mind before the movement finishes.',
    ],
  },
  {
    id: 'walk',
    category: 'Take a break',
    title: 'The long way home',
    summary: 'A familiar route can still have a different turn.',
    details: [
      'Leave a little space in the afternoon for a walk without a destination. A quiet side street, a new bookshop, or the shade of a tree can be enough of a plan.',
      'Try moving an open card up or down. Its content stays with the same card while the surrounding topics find their new places.',
    ],
  },
  {
    id: 'table',
    category: 'Get together',
    title: 'A table for good conversation',
    summary: 'Keep the food simple and leave the evening open.',
    details: [
      'A shared meal does not need a special occasion. Make something that can wait, put water on the table, and let everyone bring a story from their day.',
      'The header keeps its shape while the card changes size. Corners and shadows follow the current styling, and the text uses its destination layout.',
    ],
  },
])
const announcement = ref('')

function move(id: string, direction: -1 | 1) {
  const next = [...topics.value]
  const index = next.findIndex((topic) => topic.id === id)
  // Move events come only from the currently rendered keyed cards.
  const topic = next[index]!
  const destination = (index + direction + next.length) % next.length

  next.splice(index, 1)
  next.splice(destination, 0, topic)
  topics.value = next
  announcement.value = `${topic.title} moved to position ${destination + 1} of ${next.length}.`
}

function reverse() {
  topics.value = topics.value.toReversed()
  announcement.value = 'Topic order reversed.'
}
</script>

<template>
  <section aria-labelledby="layout-animation-title" class="layout-demo">
    <h1 id="layout-animation-title">Layout transitions</h1>
    <p class="layout-description"
    >Open a topic, reorder the cards, or change direction while they move. Vue owns the list and content; Liva follows the layout.</p>
    <div class="layout-actions">
      <button class="layout-reverse" @click="reverse">Reverse order</button>
      <p class="layout-hint">↑ and ↓ move a topic, wrapping at either end.</p>
    </div>
    <p class="layout-status" role="status">{{ announcement }}</p>
    <ol aria-label="Topics" class="topic-list">
      <TopicCard
        v-for="topic in topics"
        :key="topic.id"
        :topic="topic"
        @move="move(topic.id, $event)"
      />
    </ol>
  </section>
</template>

<style scoped>
.layout-description {
  max-inline-size: 54ch;
  margin-block: 0 20px;
  color: #64766f;
  line-height: 1.6;
}
.layout-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.layout-reverse {
  padding-block: 10px;
  padding-inline: 16px;
  border: 1px solid #c7d6bd;
  border-radius: 10px;
  background: #dce6d5;
  color: inherit;
}
.layout-hint,
.layout-status {
  margin: 0;
  color: #64766f;
  font-size: 13px;
  line-height: 1.5;
}
.layout-status {
  min-block-size: 3em;
  padding-block: 8px;
}
.topic-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0;
  margin: 0;
  list-style: none;
}
</style>
