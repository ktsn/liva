import { createApp } from 'vue'
import { createLivaPlugin } from '@liva/vue/runtime'
import Hmr from './Hmr.vue'
createApp(Hmr).use(createLivaPlugin()).mount('#app')
