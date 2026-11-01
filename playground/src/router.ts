import { createRouter, createWebHistory } from 'vue-router'
import ToggleDemo from './ToggleDemo.vue'
import BeaconDemo from './BeaconDemo.vue'
import SwipeDismissDemo from './SwipeDismissDemo.vue'
import DraggableCardDemo from './DraggableCardDemo.vue'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/toggle' },
    { path: '/toggle', component: ToggleDemo },
    { path: '/beacon', component: BeaconDemo },
    { path: '/swipe', component: SwipeDismissDemo },
    { path: '/drag', component: DraggableCardDemo },
    { path: '/:pathMatch(.*)*', redirect: '/toggle' },
  ],
})
