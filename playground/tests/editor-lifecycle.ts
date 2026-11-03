import { createApp, h } from 'vue'
import plugin from '@liva/vue'
import EditorLifecycle from './EditorLifecycle.vue'

createApp({
  render: () =>
    h('div', [
      h(EditorLifecycle, { label: 'First lifecycle' }),
      h(EditorLifecycle, { label: 'Second lifecycle' }),
    ]),
})
  .use(plugin)
  .mount('#app')
