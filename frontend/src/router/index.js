import { createRouter, createWebHistory } from 'vue-router'
import { isNativeMapEntry } from '../runtime/groupTopology.js'
import { adminSession, refreshAdminSession } from '../runtime/adminSession.js'
import { isNativeOverlaySurface } from '../runtime/nativeSurfaceBridge.js'

const routes = [
    {
        name: 'group-overview', path: '/group',
        component: () => import('../views/GroupOverview.vue'),
        meta: {title:'生产运营 · 集团分布',stableInstance:true}
    },
    {
        name: 'factory-hud-preview',
        path: '/hud-preview',
        component: () => import('../views/FactoryHudPreview.vue'),
        meta: { title: '工厂 HUD · 同源配置预览' }
    },
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
        name: 'customer-operations',
        path: '/customer',
        component: () => import('../views/CustomerOperations.vue'),
        meta: { title: '现场操作中心' }
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

const protectedPaths = new Set(['/', '/group', '/overlay', '/hud-preview', '/customer'])

router.beforeEach(async (to, from) => {
    if (!adminSession.ready) await refreshAdminSession()
    // The native host has a separate opaque /admin WebView for sign-in and
    // owns the single tab strip. Keep its transparent overlay WebView empty
    // while signed out instead of redirecting it to /admin and drawing a
    // second copy of that chrome above the host window.
    const nativeOverlay = isNativeOverlaySurface(to.query?.embedded, to.query?.surface, window.chrome?.webview)
    if (nativeOverlay && !adminSession.authenticated) return true
    if (isNativeMapEntry(to, from)) return { path: '/group', query: { ...to.query, embedded: 'unity' } }
    if (protectedPaths.has(to.path) && !adminSession.authenticated) {
        const redirect = to.path === '/' ? '/group' : to.fullPath
        return { path: '/admin', query: { ...to.query, redirect }, replace: true }
    }
    if (to.path === '/admin' && adminSession.authenticated && !adminSession.permissions.edit) {
        return { path: '/customer', query: to.query }
    }
    if (to.path === '/customer' && adminSession.authenticated
        && !adminSession.permissions.cast && !adminSession.permissions.backup) {
        return { path: '/group', query: to.query }
    }
    return true
})

router.afterEach((to) => {
    document.title = to.meta?.title || '热处理数字孪生大屏'
})

export default router
