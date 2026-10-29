import { createApp } from 'vue'
import { createLivaPlugin, type InstanceBinding } from '@liva/vue/runtime'
import Lifecycle from './Lifecycle.vue'

const records = new Set<InstanceBinding>()
const diagnostics: unknown[] = []
Object.assign(window, { records, diagnostics })
createApp(Lifecycle)
  .use(
    createLivaPlugin({
      onDiagnostic: (d) => diagnostics.push(d),
      observe: (event, record) => {
        if (event === 'mount') records.add(record)
        if (event === 'unmount') records.delete(record)
      },
    }),
  )
  .mount('#app')
