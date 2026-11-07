<script setup lang="ts">
import { ref } from 'vue'

const liked = ref(false)
</script>

<template>
  <section class="demo">
    <h1>Like button</h1>
    <p>A lasting favorite with a brief celebration each time you like it.</p>
    <button
      v-liva:like="{ liked }"
      :aria-pressed="liked"
      aria-label="Like"
      class="like-button"
      @click="liked = !liked"
    >
      <span v-liva-target:heart aria-hidden="true" class="heart">♥</span>
      <span v-liva-target:sparkLeft aria-hidden="true" class="spark spark-left">✦</span>
      <span v-liva-target:sparkTop aria-hidden="true" class="spark spark-top">✦</span>
      <span v-liva-target:sparkRight aria-hidden="true" class="spark spark-right">✦</span>
    </button>
  </section>
</template>

<style scoped>
.like-button {
  position: relative;
  display: grid;
  place-items: center;
  inline-size: 112px;
  block-size: 112px;
  border: 1px solid #d8ded2;
  border-radius: 50%;
  background: #fffefa;
}
.heart {
  display: block;
  font-size: 64px;
  line-height: 1;
}
.spark {
  position: absolute;
  color: #d54b70;
  font-size: 24px;
  pointer-events: none;

  &.spark-left {
    inset-inline-start: 6px;
    inset-block-start: 28px;
  }

  &.spark-top {
    inset-inline-start: 44px;
    inset-block-start: 0;
  }

  &.spark-right {
    inset-inline-end: 6px;
    inset-block-start: 28px;
  }
}
</style>

<liva lang="liva">
motion like(liked: boolean) {
  @tween(duration: 180, easing: easeOut)
  layer favorite {
    heart {
      color: #7b8981
      scale: 1
    }

    sparkLeft { opacity: 0; translate: 0 0; scale: 0.4 }
    sparkTop { opacity: 0; translate: 0 0; scale: 0.4 }
    sparkRight { opacity: 0; translate: 0 0; scale: 0.4 }

    state unliked initial {}

    state liked {
      heart { color: #d54b70 }
    }

    @tween(duration: 550, easing: easeOut)
    transition unliked -> liked when liked {
      heart {
        scale ~> {
          0%: 1
          35%: 1.3
          65%: 0.92
          100%: 1
        }
      }

      sparkLeft {
        opacity ~> { 0%: 0; 15%: 1; 75%: 0; 100%: 0 }
        translate ~> { 0%: 0 0; 85%: -22px -22px; 100%: 0 0 }
        scale ~> { 0%: 0.4; 50%: 1.2; 100%: 0.4 }
      }

      sparkTop {
        opacity ~> { 0%: 0; 15%: 1; 75%: 0; 100%: 0 }
        translate ~> { 0%: 0 0; 85%: 0 -28px; 100%: 0 0 }
        scale ~> { 0%: 0.4; 50%: 1.2; 100%: 0.4 }
      }

      sparkRight {
        opacity ~> { 0%: 0; 15%: 1; 75%: 0; 100%: 0 }
        translate ~> { 0%: 0 0; 85%: 22px -22px; 100%: 0 0 }
        scale ~> { 0%: 0.4; 50%: 1.2; 100%: 0.4 }
      }
    }

    transition liked -> unliked when !liked
  }
}
</liva>
