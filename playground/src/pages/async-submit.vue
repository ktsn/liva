<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'

const status = ref('idle')
const outcome = ref('success')
let request: ReturnType<typeof setTimeout> | undefined

function submit() {
  if (status.value === 'loading') return

  const result = outcome.value
  status.value = 'loading'
  request = setTimeout(() => {
    status.value = result
  }, 800)
}

onScopeDispose(() => clearTimeout(request))
</script>

<template>
  <section class="demo">
    <h1>Async submit</h1>
    <p>Vue owns the request and prevents duplicates. Liva expires the visual feedback.</p>
    <label>
      Request outcome
      <select v-model="outcome" data-testid="submit-outcome">
        <option value="success">Success</option>
        <option value="error">Error</option>
      </select>
    </label>
    <button
      v-liva:submit="{ status }"
      :disabled="status === 'loading'"
      data-testid="submit"
      @click="submit"
    >
      Submit
      <span v-liva-target:loading aria-hidden="true"> · Sending…</span>
      <span v-liva-target:success aria-hidden="true"> · Saved ✓</span>
      <span v-liva-target:error aria-hidden="true"> · Failed — try again</span>
    </button>
    <p role="status">{{
      status === 'loading'
        ? 'Saving…'
        : status === 'error'
          ? 'Request failed'
          : status === 'success'
            ? 'Saved'
            : 'Ready'
    }}</p>
  </section>
</template>

<liva lang="liva">
motion submit(status: string) {
  let feedbackExpired = timeout(when: status == "success" || status == "error", duration: 1500)

  @tween(duration: 240, easing: easeOut)
  layer request {
    scale: 1
    translate: 0 0
    opacity: 1
    background-color: #d9f3e8
    loading { display: none @instant }
    success { display: none @instant }
    error { display: none @instant }

    state idle initial {}

    state pending {
      opacity: 0.6
      loading { display: inline @instant }
    }

    state success {
      background-color: #64c69e
      success { display: inline @instant }
    }

    state error {
      background-color: #f0a3a3
      error { display: inline @instant }
    }

    transition idle -> pending when status == "loading"
    transition success -> pending when status == "loading"
    transition error -> pending when status == "loading"

    transition pending -> success when status == "success" {
      @tween(duration: 300)
      scale ~> { 50%: 1.15 }
    }

    transition pending -> error when status == "error" {
      @tween(duration: 300)
      translate ~> { 25%: -5px 0; 75%: 5px 0 }
    }

    transition success -> idle when feedbackExpired
    transition error -> idle when feedbackExpired
  }
}
</liva>
