import { createApp, h } from 'vue'
import plugin from '@liva/vue'
import EditorLayerLifecycle from './EditorLayerLifecycle.vue'

createApp({
  render: () =>
    h('div', [
      h(EditorLayerLifecycle, { label: 'First lifecycle' }),
      h(EditorLayerLifecycle, { label: 'Second lifecycle' }),
    ]),
})
  .use(plugin)
  .mount('#app')
