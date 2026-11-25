<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'

const open = ref(false)
const leftTape = useTemplateRef('leftTape')
const rightTape = useTemplateRef('rightTape')
const landing = ref({
  leftOpacity: '0.55',
  leftScale: '1.18',
  leftTranslate: '-12px -38px',
  leftShadow: '0px 16px 14px #173d3626',
  rightOpacity: '0.55',
  rightScale: '1.18',
  rightTranslate: '12px -32px',
  rightShadow: '0px 16px 14px #173d3626',
})

function toggle() {
  if (open.value) {
    if (!leftTape.value || !rightTape.value) return
    // Hold the displayed pose, including a partially completed lift, until the card closes.
    // These local inputs are sampled only on activation; Liva owns playback and cancellation.
    const left = getComputedStyle(leftTape.value)
    const right = getComputedStyle(rightTape.value)
    landing.value = {
      leftOpacity: left.opacity,
      leftScale: left.scale,
      leftTranslate: left.translate,
      leftShadow: left.boxShadow,
      rightOpacity: right.opacity,
      rightScale: right.scale,
      rightTranslate: right.translate,
      rightShadow: right.boxShadow,
    }
  }
  open.value = !open.value
}
</script>

<template>
  <section class="demo">
    <h1>Photo tape</h1>
    <p>Lift the tape to open the card. Close it to let each piece settle back into place.</p>
    <div v-liva:photoTape="{ open, ...landing }" class="photo-stage">
      <div v-liva-target:card class="photo-card">
        <svg aria-label="An alpine lake beneath a sunset sky" role="img" viewBox="0 0 300 220">
          <rect fill="#d9e7dc" height="220" width="300" />
          <circle cx="224" cy="55" fill="#efb47d" r="25" />
          <path d="M0 155 86 35 168 151 229 74 300 153V220H0Z" fill="#74998a" />
          <path d="m58 74 28-39 30 43-30-12Z" fill="#fffefa" />
          <path d="M0 155Q80 137 150 158T300 151V220H0Z" fill="#356b72" />
          <path d="M175 183h65m-105 14h77" stroke="#d9e7dc" stroke-width="3" />
        </svg>
        <span class="caption">A quiet afternoon · Alpine lake</span>
      </div>
      <span ref="leftTape" v-liva-target:leftTape aria-hidden="true" class="tape tape-left"></span>
      <span ref="rightTape" v-liva-target:rightTape aria-hidden="true" class="tape tape-right"></span>
    </div>
    <button :aria-pressed="open" class="photo-control" @click="toggle">Open photo</button>
    <p class="timing-note"
    >A 400 ms close, then two staggered landings. Try reversing mid-motion.</p>
  </section>
</template>

<style scoped>
.photo-stage {
  position: relative;
  inline-size: min(100%, 340px);
  margin: 56px auto 40px;
}
.photo-card {
  padding: 12px 12px 20px;
  background: #fffefa;
  box-shadow: 0 8px 24px #173d3626;
  transform-origin: center bottom;
}
.photo-card svg {
  display: block;
  inline-size: 100%;
}
.caption {
  display: block;
  margin-block-start: 14px;
  font-size: 12px;
  text-align: center;
}
.tape {
  position: absolute;
  inset-block-start: -12px;
  inline-size: 72px;
  block-size: 32px;
  background: repeating-linear-gradient(90deg, #dfca8e, #dfca8e 3px, #e5d49d 4px);
  border: 1px solid #c5b278;
  pointer-events: none;
}
.tape-left {
  inset-inline-start: 8px;
  rotate: -24deg;
}
.tape-right {
  inset-inline-end: 8px;
  rotate: 20deg;
}
.photo-control {
  border: 1px solid #c7d6bd;
  border-radius: 24px;
  padding: 12px 24px;
  background: #dce6d5;
  color: #173d36;
}
.timing-note {
  font-size: 13px;
  color: #64766f;
}
</style>

<liva lang="liva">
motion photoTape(
  open: boolean,
  leftOpacity: string, leftScale: string, leftTranslate: string, leftShadow: string,
  rightOpacity: string, rightScale: string, rightTranslate: string, rightShadow: string
) {
  layer pose {
    card { scale: 1; rotate: 0deg }
    leftTape { opacity: 1; scale: 1; translate: 0 0; box-shadow: 0px 1px 2px #173d3640 }
    rightTape { opacity: 1; scale: 1; translate: 0 0; box-shadow: 0px 1px 2px #173d3640 }

    state closed initial {}
    state opened {
      card { scale: 1.06; rotate: -3deg }
      leftTape { opacity: 0.55; scale: 1.18; translate: -12px -38px; box-shadow: 0px 16px 14px #173d3626 }
      rightTape { opacity: 0.55; scale: 1.18; translate: 12px -32px; box-shadow: 0px 16px 14px #173d3626 }
    }

    @tween(duration: 600, easing: easeOut)
    transition closed -> opened when open {
      leftTape {
        @tween(duration: 280, easing: linear)
        opacity ~> { 100%: 0.55 }
        @tween(duration: 360, easing: easeOut)
        scale ~> { 100%: 1.18 }
        @tween(duration: 320, easing: easeIn)
        box-shadow ~> { 100%: 0px 16px 14px #173d3626 }
      }
      rightTape {
        @tween(duration: 360, easing: linear)
        opacity ~> { 100%: 0.55 }
        @tween(duration: 420, easing: easeOut)
        scale ~> { 100%: 1.18 }
        @tween(duration: 400, easing: easeIn)
        box-shadow ~> { 100%: 0px 16px 14px #173d3626 }
      }
    }

    // Fixed choreography: each held segment below ends after the 400 ms card close.
    // State reversal replaces these effects; there is no deferred landing callback.
    @tween(duration: 1000, easing: easeOut)
    transition opened -> closed when !open {
      @tween(duration: 400, easing: easeInOut)
      card {}
      leftTape {
        translate ~> { 45%: ${leftTranslate} }
        @tween(duration: 800, easing: linear)
        opacity ~> { 60%: ${leftOpacity} }
        @tween(duration: 1000, easing: easeOut)
        scale ~> { 45%: ${leftScale} }
        @tween(duration: 900, easing: easeIn)
        box-shadow ~> { 60%: ${leftShadow} }
      }
      rightTape {
        translate ~> { 55%: ${rightTranslate} }
        @tween(duration: 900, easing: linear)
        opacity ~> { 65%: ${rightOpacity} }
        @tween(duration: 1000, easing: easeOut)
        scale ~> { 55%: ${rightScale} }
        @tween(duration: 1000, easing: easeIn)
        box-shadow ~> { 65%: ${rightShadow} }
      }
    }
  }
}
</liva>
