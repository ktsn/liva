import { createApp } from 'vue'
import { createCompiledLivaPlugin } from '@liva/vue/compiled'
import FeatureLayout from './FeatureLayout.vue'

createApp(FeatureLayout).use(createCompiledLivaPlugin()).mount('#app')
