import { createApp } from 'vue'
import { createCompiledLivaPlugin } from '@liva/vue/compiled'
import Hmr from './Hmr.vue'
createApp(Hmr).use(createCompiledLivaPlugin()).mount('#app')
