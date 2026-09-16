import { createRouter, createWebHistory } from 'vue-router'

const routes = [
    {
        name: 'dashboard',
        path: '/',
        component: () => import('../views/DeprecatedDashboard.vue'),
        meta: { title: '旧版网页大屏已弃用' }
    },
    {
        name: 'admin',
        path: '/admin',
        component: () => import('../views/AdminAccess.vue'),
        meta: { title: '热处理大屏后台', keepAlive: true }
    },
    {
        name: 'dashboard-overlay',
        path: '/overlay',
        component: () => import('../views/DashboardOverlay.vue'),
        meta: { title: '数字孪生透明数据层' }
    }
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

router.afterEach((to) => {
    document.title = to.meta?.title || '热处理数字孪生大屏'
})

export default router
