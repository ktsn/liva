import { createApp } from 'vue'
import { createLivaPlugin, type InstanceBinding } from '@liva/vue/runtime'
import Presence from './Presence.vue'

const records = new Set<InstanceBinding>()
const diagnostics: unknown[] = []
const app = createApp(Presence).use(
  createLivaPlugin({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    observe(event, record) {
      if (event === 'mount') records.add(record)
      if (event === 'unmount') records.delete(record)
    },
  }),
)
Object.assign(window, { records, diagnostics, teardown: () => app.unmount() })
app.mount('#app')
