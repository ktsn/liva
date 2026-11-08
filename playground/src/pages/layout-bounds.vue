<script setup lang="ts">
import { ref } from 'vue'

const selected = ref(0)
const expanded = ref(false)
const detailed = ref(false)
</script>

<template>
  <section class="demo">
    <h1>Measured layout</h1>
    <p>Liva reads layout bounds; Vue only changes selection and content.</p>
    <div v-liva:tabs="{ selected }" aria-label="View" class="measured-tabs" role="group">
      <div v-liva-target:indicator aria-hidden="true" class="measured-indicator"></div>
      <button
        v-liva-target:first
        class="measured-tab"
        :aria-pressed="selected === 0"
        @click="selected = 0"
      >Overview</button>
      <button
        v-liva-target:second
        class="measured-tab"
        :aria-pressed="selected === 1"
        @click="selected = 1"
      >Activity and updates</button>
      <button
        v-liva-target:third
        class="measured-tab"
        :aria-pressed="selected === 2"
        @click="selected = 2"
      >Files</button>
    </div>

    <button
      :aria-expanded="expanded"
      aria-controls="measured-details"
      @click="expanded = !expanded"
    >{{ expanded ? 'Collapse' : 'Expand' }} details</button>
    <div id="measured-details" v-liva:expansion="{ expanded }" class="measured-shell">
      <div v-liva-target:inner class="measured-inner">
        <p>The shell follows the naturally sized inner content, including responsive wrapping.</p>
        <p v-if="detailed"
        >Changing content or viewport width updates the measured height. No application resize handler, timer, or DOM measurement is needed.</p>
      </div>
    </div>
    <button :aria-pressed="detailed" @click="detailed = !detailed"
    >{{ detailed ? 'Less' : 'More' }} content</button>
  </section>
</template>

<style scoped>
.measured-tabs {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem;
  border: 1px solid #a9c8bd;
  border-radius: 1rem;
}

.measured-tab {
  position: relative;
  background: transparent;
  border: 0;
}

.measured-indicator {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  background: #b8e6d2;
  border-radius: 0.5rem;
  pointer-events: none;
}

.measured-shell {
  overflow: clip;
}

.measured-inner {
  padding-block: 1rem;
  display: flow-root;
}
</style>

<liva lang="liva">
motion tabs(selected: number) {
  let firstBounds = measure(target: first)
  let secondBounds = measure(target: second)
  let thirdBounds = measure(target: third)

  @spring(duration: 350, bounce: 0.1)
  layer selection {
    first {}
    second {}
    third {}
    indicator {
      translate: ${firstBounds.x}px ${firstBounds.y}px
      inline-size: ${firstBounds.width}px
      block-size: ${firstBounds.height}px
    }
  }

  layer secondSelected when selected == 1 {
    indicator {
      translate: ${secondBounds.x}px ${secondBounds.y}px
      inline-size: ${secondBounds.width}px
      block-size: ${secondBounds.height}px
    }
  }

  layer thirdSelected when selected == 2 {
    indicator {
      translate: ${thirdBounds.x}px ${thirdBounds.y}px
      inline-size: ${thirdBounds.width}px
      block-size: ${thirdBounds.height}px
    }
  }
}

motion expansion(expanded: boolean) {
  let bounds = measure(target: inner)

  @spring(duration: 350, bounce: 0)
  layer size {
    inner {}
    block-size: 0px
  }

  layer expanded when expanded {
    block-size: ${bounds.height}px
  }
}
</liva>
