<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, useTemplateRef } from 'vue'

const frame = useTemplateRef<HTMLElement>('frame')
// Liva's instant --snap property indexes this keyboard/accessibility order.
const snapNames = ['Closed', 'Half', 'Expanded'] as const
const snap = ref(1)
const command = ref(-1)
const saved = ref(false)
let observer: MutationObserver | undefined
const stops = [
  ['Botanical garden', 'A quiet path through the glasshouses and old trees.'],
  ['Riverside market', 'Fresh bread, seasonal produce, and a coffee by the water.'],
  ['Design museum', 'An afternoon of everyday objects and unexpected ideas.'],
  ['Hilltop lookout', 'Take the long way up for a view across the city.'],
  ['Neighborhood bookshop', 'Browse the shelves and find something to take home.'],
  ['Evening courtyard', 'Finish the day with a meal under the lanterns.'],
]

// The stateful Liva layer owns this instant property. Observe only its root's
// inline style, rather than sampling the animated sheet or polling each frame.
function currentSnap(style: CSSStyleDeclaration) {
  return Number(style.getPropertyValue('--snap'))
}

onMounted(() => {
  const element = frame.value!
  observer = new MutationObserver(() => {
    snap.value = currentSnap(getComputedStyle(element))
  })

  snap.value = currentSnap(getComputedStyle(element))
  observer.observe(element, { attributes: true, attributeFilter: ['style'] })
})

onScopeDispose(() => observer?.disconnect())

function preventHandleSelection(event: MouseEvent) {
  if (event.button !== 0) return

  const handle = event.currentTarget as HTMLElement

  // WebKit can start selection outside a moving handle, bypassing its
  // selectstart listener. Cancel the initiating mouse action instead, and
  // preserve the focus it would normally give this keyboard-operable slider.
  event.preventDefault()
  handle.focus({ preventScroll: true })
}

async function controlSheet(event: KeyboardEvent) {
  const element = frame.value!
  const style = getComputedStyle(element)
  const current = currentSnap(style)
  const destinations: Record<string, number> = {
    ArrowUp: Math.min(snapNames.length - 1, current + 1),
    ArrowDown: Math.max(0, current - 1),
    Home: 0,
    End: snapNames.length - 1,
  }
  const destination = destinations[event.key]

  if (destination === undefined) return

  event.preventDefault()

  if (style.getPropertyValue('--dragging').trim() === '1') return

  command.value = destination

  // A command is an input pulse, not persistent application snap state. Clear it
  // after Vue delivers it so a later pointer release cannot replay an old key.
  await nextTick()

  command.value = -1
}
</script>

<template>
  <section aria-labelledby="bottom-sheet-title" class="demo">
    <h1 id="bottom-sheet-title">Bottom sheet</h1>
    <p class="sheet-instructions">Drag the handle, or focus it and use ↑ / ↓, Home, and End.</p>

    <div ref="frame" v-liva:bottomSheet="{ command }" class="sheet-frame" data-testid="sheet-frame">
      <div class="sheet-background">
        <span class="sheet-eyebrow">A day outside</span>
        <h2 class="sheet-heading">Find your<br />next stop.</h2>
        <p class="sheet-description">A few favorite places for an unhurried afternoon.</p>
        <button class="sheet-save" :aria-pressed="saved" @click="saved = !saved">
          {{ saved ? 'Route saved ✓' : 'Save this route' }}
        </button>
        <div aria-hidden="true" class="sheet-map">
          <span class="sheet-map-route"></span>
          <span class="sheet-map-pin">1</span>
          <span class="sheet-map-pin sheet-map-pin-end">2</span>
        </div>
      </div>

      <section
        v-liva-target:sheet
        aria-label="Suggested stops"
        class="bottom-sheet"
        data-testid="bottom-sheet"
      >
        <div
          v-liva-target:handle
          aria-label="Sheet position"
          aria-orientation="vertical"
          :aria-valuemax="snapNames.length - 1"
          aria-valuemin="0"
          class="sheet-handle"
          role="slider"
          tabindex="0"
          :aria-valuenow="snap"
          :aria-valuetext="snapNames[snap]"
          @keydown="controlSheet"
          @mousedown="preventHandleSelection"
        >
          <span aria-hidden="true" class="sheet-grip"></span>
          <span aria-hidden="true" class="sheet-handle-label">Explore nearby <span>{{
              snapNames[snap]
            }}</span></span>
        </div>

        <div class="sheet-content" :inert="snap === 0" aria-label="Places to explore" tabindex="0">
          <p class="sheet-content-intro">Make a little room for discovery.</p>
          <ol class="sheet-stops">
            <li v-for="([title, description], index) in stops" :key="title" class="sheet-stop">
              <span aria-hidden="true" class="sheet-stop-number">{{ index + 1 }}</span>
              <div>
                <h3 class="sheet-stop-title">{{ title }}</h3>
                <p class="sheet-stop-description">{{ description }}</p>
              </div>
            </li>
          </ol>
          <p class="sheet-content-footer">No rush. The best detours are the ones you choose.</p>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.sheet-instructions {
  margin-block: -8px 24px;
  color: #64766f;
  font-size: 14px;
}

.sheet-frame {
  position: relative;
  inline-size: 100%;
  max-inline-size: 393px;
  aspect-ratio: 393 / 852;
  overflow: clip;
  isolation: isolate;
  border-radius: 28px;
  background: #e0e8da;
  box-shadow: 0 12px 40px #173d3618;
}

.sheet-background {
  padding: 32px 24px;
}

.sheet-eyebrow {
  color: #516d58;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.sheet-heading {
  margin-block: 20px 12px;
  font-size: clamp(24px, 4vw, 40px);
  font-weight: 500;
  line-height: 1.12;
  letter-spacing: -0.04em;
}

.sheet-description {
  max-inline-size: 240px;
  color: #516d58;
  font-size: 14px;
  line-height: 1.6;
}

.sheet-save {
  margin-block-start: 8px;
  padding: 10px 16px;
  border: 1px solid #a9bb9f;
  border-radius: 24px;
  background: #edf2e6;
  color: #173d36;
  font-size: 13px;
}

.sheet-map {
  pointer-events: none;
  position: absolute;
  inset-block: 42% 10%;
  inset-inline: 12%;
  border: 1px solid #c2cfb8;
  border-radius: 50% 30% 45% 25%;
  rotate: -15deg;
  background: #d3dfc7;
}

.sheet-map-route {
  position: absolute;
  inset-block: 20%;
  inset-inline: 25%;
  border: 2px dashed #8ca77c;
  border-radius: 40%;
}

.sheet-map-pin {
  position: absolute;
  inset-block-start: 12%;
  inset-inline-start: 20%;
  display: grid;
  place-items: center;
  inline-size: 32px;
  block-size: 32px;
  border-radius: 50%;
  background: #516d58;
  color: white;
  rotate: 15deg;

  &.sheet-map-pin-end {
    inset-block-start: 70%;
    inset-inline-start: 65%;
  }
}

.bottom-sheet {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  min-block-size: var(--sheet-header-height);
  display: flex;
  flex-direction: column;
  border-radius: 24px 24px 0 0;
  background: #fffefa;
  box-shadow: 0 -8px 28px #173d361a;
}

.sheet-handle {
  flex: 0 0 var(--sheet-header-height);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding-inline: 20px;
  border-radius: 24px 24px 0 0;
  touch-action: none;
  user-select: none;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }

  &:focus-visible {
    outline: 3px solid #cf6c3f;
    outline-offset: -5px;
  }
}

.sheet-grip {
  inline-size: 32px;
  block-size: 4px;
  border-radius: 4px;
  background: #b9c5bb;
}

.sheet-handle-label {
  display: flex;
  justify-content: space-between;
  inline-size: 100%;
  font-size: 13px;
  font-weight: 600;
}

.sheet-content {
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-inline: 20px;

  &:focus-visible {
    outline: 3px solid #cf6c3f;
    outline-offset: -3px;
  }
}

.sheet-content-intro {
  margin-block: 16px 24px;
  font-size: 20px;
  line-height: 1.4;
}

.sheet-stops {
  margin: 0;
  padding: 0;
  list-style: none;
}

.sheet-stop {
  display: flex;
  gap: 14px;
  padding-block: 20px;
  border-block-start: 1px solid #e2e6dc;
}

.sheet-stop-number {
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  align-self: start;
  block-size: 28px;
  border-radius: 50%;
  background: #edf2e6;
  color: #516d58;
  font-size: 12px;
}

.sheet-stop-title {
  margin-block: 2px 8px;
  margin-inline: 0;
  font-size: 15px;
  font-weight: 600;
}

.sheet-stop-description,
.sheet-content-footer {
  margin: 0;
  color: #64766f;
  font-size: 13px;
  line-height: 1.65;
}

.sheet-content-footer {
  padding-block: 16px 32px;
}
</style>

<liva lang="liva">
motion bottomSheet(command: number) {
  let headerHeight = 56
  let bounds = measure(target: self)
  let pointer = drag(target: handle)
  let movement = link(input: pointer.offset.y)

  // All positions are CSS pixels down from the frame's top. Controller velocity
  // is pixels per millisecond; 200ms is this demo's release projection policy.
  let closedY = bounds.height - headerHeight
  let halfY = bounds.height * 0.5
  let expandedY = bounds.height * 0.1
  let projectedY = movement.value + movement.velocity * 200
  let closedMidpoint = (closedY + halfY) / 2
  let expandedMidpoint = (halfY + expandedY) / 2

  @spring(stiffness: 300, damping: 30)
  layer position {
    --sheet-header-height: ${headerHeight}px @instant
    --dragging: 0 @instant
    handle {}

    state half initial {
      --snap: 1 @instant
      sheet { inset-block-start: ${halfY}px }
    }

    state closed {
      --snap: 0 @instant
      sheet { inset-block-start: ${closedY}px }
    }

    state expanded {
      --snap: 2 @instant
      sheet { inset-block-start: ${expandedY}px }
    }

    transition closed -> half when !pointer.active && command == 1
    transition closed -> expanded when !pointer.active && command == 2
    transition half -> closed when !pointer.active && command == 0
    transition half -> expanded when !pointer.active && command == 2
    transition expanded -> closed when !pointer.active && command == 0
    transition expanded -> half when !pointer.active && command == 1

    // Candidates overlap deliberately: the last eligible transition wins, so
    // exact midpoint ties choose the more open state, including fast skips.
    on pointer.release {
      transition closed -> closed
      transition closed -> half when projectedY <= closedMidpoint
      transition closed -> expanded when projectedY <= expandedMidpoint
      transition half -> closed
      transition half -> half when projectedY <= closedMidpoint
      transition half -> expanded when projectedY <= expandedMidpoint
      transition expanded -> closed
      transition expanded -> half when projectedY <= closedMidpoint
      transition expanded -> expanded when projectedY <= expandedMidpoint
    }
  }

  layer dragging when pointer.active {
    --dragging: 1 @instant
    sheet { inset-block-start := movement }
  }
}
</liva>
