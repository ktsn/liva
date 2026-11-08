import { createApp } from 'vue'
import plugin from '@liva/vue'
import EditorSelf from './EditorSelf.vue'

createApp(EditorSelf).use(plugin).mount('#app')
