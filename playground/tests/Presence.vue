<script setup lang="ts">
import { defineComponent, h, onUnmounted, ref } from 'vue'
const UnmountProbe = defineComponent({
  setup() {
    onUnmounted(() => document.dispatchEvent(new CustomEvent('probe-unmounted')))
    return () => h('span', { id: 'probe' }, 'Probe')
  },
})
const dimmed = ref(false)
const parameters = ref({ value: false, owner: false, entries: false })
const visible = ref(true)
const shown = ref(true)
const branch = ref(0)
const items = ref([1, 2])
const rootVisible = ref(true)
const innerVisible = ref(true)

function updateBindings() {
  dimmed.value = true
  parameters.value = { value: true, owner: true, entries: true }
}
</script>

<template>
  <button id="binding-update" @click="updateBindings">Update bindings</button>
  <div id="manual-binding" v-liva:nested="{ dimmed }" v-liva-target:body>Manual</div>
  <div id="parameter-binding" v-liva:parameters="parameters" v-liva-target:body>Parameters</div>
  <button id="toggle" @click="visible = !visible">Toggle</button>
  <button id="show" @click="shown = !shown">Show</button>
  <button id="branch" @click="branch = (branch + 1) % 3">Branch</button>
  <button id="root-toggle" @click="rootVisible = !rootVisible">Root</button>
  <button id="inner-toggle" @click="innerVisible = !innerVisible">Inner</button>
  <button id="remove" @click="items = items.slice(1)">Remove</button>
  <div v-liva:panel>
    <section v-if="visible" id="ancestor">
      <UnmountProbe />
      <div id="content" v-liva-target:content>Content</div>
      <div id="secondary" v-liva-target:secondary>Secondary</div>
      <div v-if="innerVisible" id="nested" v-liva:nested="{ dimmed: false }" v-liva-target:body
      >Nested</div>
    </section>
    <div v-if="visible" id="direct" v-liva-target:direct>Direct</div>
    <div v-show="shown" id="direct-visibility" v-liva-target:directVisibility>
      Direct visibility
    </div>
    <div v-for="item in items" :id="'repeated-' + item" :key="item" v-liva-target:repeated>
      Repeated target
    </div>
    <section v-show="shown" id="show-ancestor">
      <div id="visibility" v-liva-target:visibility>Visibility</div>
    </section>
    <div v-if="branch === 0" id="first" v-liva-target:first>First</div>
    <section v-else-if="branch === 1" id="second">
      <div v-liva-target:second>Second</div>
    </section>
    <section v-else id="third">
      <div v-liva-target:third>Third</div>
    </section>
  </div>
  <div v-if="rootVisible" id="motion-root" v-liva:nested="{ dimmed: false }" v-liva-target:body
  >Root</div>
  <section v-for="item in items" :id="'row-' + item" :key="item">
    <div :id="'row-body-' + item" v-liva:nested="{ dimmed: false }" v-liva-target:body>Row</div>
  </section>
</template>

<style scoped>
#content,
#visibility {
  color: rgb(12, 34, 56);
}
</style>

<liva lang="liva">
motion panel {
  layer base {
    direct {
      opacity: 1
    }

    directVisibility {
      opacity: 1
    }

    repeated {
      opacity: 0.8
    }

    content {
      opacity: 1
    }

    secondary {
      opacity: 1
    }

    visibility {
      opacity: 1
    }

    first {
      opacity: 1
    }

    second {
      opacity: 1
    }

    third {
      opacity: 1
    }
  }

  @tween(duration: 100) enter {

    direct {
      opacity ~> {
        0%: 0
      }
    }

    directVisibility {
      opacity ~> {
        0%: 0
      }
    }

    content {
      opacity ~> {
        0%: 0
      }
    }

    secondary {
      opacity ~> {
        0%: 0
      }
    }

    visibility {
      opacity ~> {
        0%: 0
      }
    }

    first {
      opacity ~> {
        0%: 0
      }
    }

    second {
      opacity ~> {
        0%: 0
      }
    }

    third {
      opacity ~> {
        0%: 0
      }
    }
  }

  @tween(duration: 300) leave {

    direct {
      opacity ~> {
        100%: 0
      }
    }

    directVisibility {
      opacity ~> {
        100%: 0
      }
    }

    repeated {
      opacity ~> {
        100%: 0
      }
    }

    content {
      opacity ~> {
        100%: 0
      }
    }

    secondary {
      @tween(duration: 500) opacity ~> {
        100%: 0
      }
    }

    visibility {
      opacity ~> {
        100%: 0
      }
    }

    first {
      opacity ~> {
        100%: 0
      }
    }

    second {
      opacity ~> {
        100%: 0
      }
    }

    third {
      opacity ~> {
        100%: 0
      }
    }
  }
}

motion nested(dimmed: boolean) {
  @tween(duration: 1) layer base {
    body {
      opacity: 1
    }
  }

  layer dim when dimmed {
    body {
      opacity: 0.4
    }
  }

  @tween(duration: 400) leave {

    body {
      opacity ~> {
        100%: 0
      }
    }
  }
}

motion parameters(value: boolean, owner: boolean, entries: boolean) {
  @tween(duration: 1) layer base {
    body {
      opacity: 1
    }
  }

  layer dim when value && owner && entries {
    body {
      opacity: 0.3
    }
  }

  @tween(duration: 100) enter {

    body {
      opacity ~> {
        0%: 0
      }
    }
  }
}
</liva>
