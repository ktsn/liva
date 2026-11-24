<script setup lang="ts">
import { nextTick, ref } from 'vue'

defineProps<{
  topic: {
    id: string
    category: string
    title: string
    summary: string
    details: readonly string[]
  }
}>()
const emit = defineEmits<{ move: [direction: -1 | 1] }>()
const expanded = ref(false)

async function move(direction: -1 | 1, event: MouseEvent) {
  const control = event.currentTarget
  const wasFocused = control === document.activeElement

  emit('move', direction)
  await nextTick()

  // Moving a keyed DOM subtree can drop its focused button to the document body.
  // Preserve that user focus without scrolling or taking focus from another control.
  if (
    wasFocused &&
    control instanceof HTMLElement &&
    control.isConnected &&
    document.activeElement === document.body
  )
    control.focus({ preventScroll: true })
}
</script>

<template>
  <li v-liva:topic="{ expanded }" class="topic-card" :class="{ expanded }" :data-topic="topic.id">
    <header v-liva-target:header class="topic-header">
      <div class="topic-introduction">
        <p class="topic-category">{{ topic.category }}</p>
        <h2 class="topic-title">
          <button
            class="topic-toggle"
            :aria-controls="`topic-details-${topic.id}`"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
          >{{ topic.title }}<span aria-hidden="true" class="topic-indicator">{{
              expanded ? '−' : '+'
            }}</span></button>
        </h2>
        <div v-if="!expanded" v-liva-target:summary class="topic-preview">
          <svg aria-hidden="true" class="topic-art" focusable="false" viewBox="0 0 80 56">
            <rect fill="#dce6d5" height="56" rx="8" width="80" />
            <circle cx="61" cy="15" fill="#e7b86c" r="8" />
            <path d="M0 43 24 19 48 43 64 29 80 45V56H0Z" fill="#88a38a" />
            <path d="M0 50 27 38 51 48 80 39V56H0Z" fill="#487857" />
          </svg>
          <p class="topic-summary">{{ topic.summary }}</p>
        </div>
      </div>
      <div aria-label="Change topic order" class="topic-order" role="group">
        <button class="topic-move" :aria-label="`Move ${topic.title} up`" @click="move(-1, $event)"
        >↑</button>
        <button
          class="topic-move"
          :aria-label="`Move ${topic.title} down`"
          @click="move(1, $event)"
        >↓</button>
      </div>
    </header>
    <div
      v-if="expanded"
      :id="`topic-details-${topic.id}`"
      v-liva-target:details
      class="topic-details"
    >
      <p v-for="paragraph in topic.details" :key="paragraph" class="topic-paragraph">{{
        paragraph
      }}</p>
      <a
        v-liva-target:reference
        class="topic-reference"
        href="https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Flow_layout"
      >Read about natural CSS layout</a>
    </div>
  </li>
</template>

<style scoped>
.topic-card {
  --topic-padding: 22px;
  inline-size: calc(100% - 24px);
  transform-origin: top center;
  padding: var(--topic-padding);
  border: 1px solid #cbd8cb;
  border-radius: 18px;
  background: #fffefa;
  box-shadow: 0 3px 12px #173d3614;
  overflow: clip;
}
.topic-card.expanded {
  inline-size: 100%;
}
/* Keep line wrapping fixed while the paper grows around its content. */
.topic-header,
.topic-details {
  inline-size: calc(100cqi - 24px - 2px - var(--topic-padding) - var(--topic-padding));
}
.topic-header {
  display: flex;
  gap: 16px;
  align-items: start;
  justify-content: space-between;
}
.topic-introduction {
  min-inline-size: 0;
  flex: 1;
}
.topic-category {
  margin-block: 0 8px;
  margin-inline: 0;
  color: #64766f;
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.topic-title {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.35;
}
.topic-toggle {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  inline-size: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: start;
  font: inherit;
}
.topic-indicator {
  flex: none;
  color: #487857;
}
.topic-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-block-start: 10px;
}
.topic-art {
  inline-size: 64px;
  block-size: 44.8px;
  flex: none;
}
.topic-summary {
  flex: 1 1 16ch;
  margin: 0;
  color: #64766f;
  font-size: 14px;
  line-height: 1.5;
}
.topic-order {
  display: flex;
  gap: 4px;
  flex: none;
}
.topic-move {
  inline-size: 32px;
  block-size: 34px;
  padding: 0;
  border: 1px solid #d8ded2;
  border-radius: 8px;
  background: #eeeee5;
  color: inherit;
}
.topic-details {
  padding-block-start: 6px;
  line-height: 1.65;
  font-size: 14px;
}
.topic-paragraph {
  margin-block: 14px;
}
.topic-reference {
  color: #345c42;
  text-underline-offset: 3px;
}
@media (max-width: 600px) {
  .topic-card {
    --topic-padding: 16px;
  }
  .topic-header {
    flex-direction: column;
    gap: 12px;
  }
  .topic-title {
    font-size: 17px;
  }
}
</style>

<liva>
motion topic(expanded: boolean) {
  @spring(duration: 500, bounce: .1)
  layer base {
    $layout: position size
    rotate: -.5deg
    header { $layout: position }
    summary { opacity: 1 }
    details { $layout: position; opacity: 1; translate: 0px 0px }
    reference { opacity: 1 }
  }

  @tween(duration: 240, easing: easeOut)
  layer expanded when expanded {
    rotate: 0deg
    border-radius: 26px
    box-shadow: 0px 12px 28px #173d3624
  }

  // Holds in property tracks coordinate entry without timers or a second timeline.
  @tween(duration: 420, easing: easeOut)
  enter {
    summary { opacity ~> { 0%: 0; 60%: 0 } }
    details {
      opacity ~> { 0%: 0; 35%: 0 }
      translate: 0px 12px
    }
    reference { opacity ~> { 0%: 0; 65%: 0 } }
  }
  @tween(duration: 140, easing: easeOut)
  leave {
    summary { opacity: 0 }
    details { opacity: 0; translate: 0px -8px }
    reference { opacity: 0 }
  }
}
</liva>
