import { createApp } from 'vue'
import liva from '@liva/vue'
import App from './App.vue'
import { router } from './router.ts'

createApp(App).use(liva).use(router).mount('#app')
