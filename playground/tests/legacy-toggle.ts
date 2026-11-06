import { createApp, h, ref } from 'vue'
import plugin from '@liva/vue'
import Toggle from './LegacyToggle.vue'

createApp({
  setup() {
    const visible = ref(true)

    return () =>
      h('div', [
        ...(visible.value
          ? [h(Toggle, { label: 'Notifications' }), h(Toggle, { label: 'Product updates' })]
          : []),
        h(
          'button',
          {
            onClick: () => {
              visible.value = !visible.value
            },
          },
          visible.value ? 'Unmount switches' : 'Mount switches',
        ),
      ])
  },
})
  .use(plugin)
  .mount('#app')
