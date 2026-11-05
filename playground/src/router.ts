import { createRouter, createWebHistory } from 'vue-router'
import { routes, handleHotUpdate } from 'vue-router/auto-routes'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    ...routes,
    { path: '/', redirect: '/toggle' },
    { path: '/:pathMatch(.*)*', redirect: '/toggle' },
  ],
})

if (import.meta.hot) {
  handleHotUpdate(router)
}
