import { createApp } from 'vue'
import { createCompiledLivaPlugin } from '@liva/vue/compiled'

const fixtures = {
  registry: () => import('./PresenceRegistry.vue'),
  attribute: () => import('./PresenceAttribute.vue'),
  hot: () => import('./PresenceHot.vue'),
}
const fixture = new URLSearchParams(location.search).get('fixture')

if (fixture !== 'registry' && fixture !== 'attribute' && fixture !== 'hot') {
  throw new Error('Choose a Presence fixture')
}

const { default: component } = await fixtures[fixture]()
createApp(component).use(createCompiledLivaPlugin()).mount('#app')
