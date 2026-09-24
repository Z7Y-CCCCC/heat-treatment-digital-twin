<script setup>
import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { adminSession, issueNativeSessionTicket, lockAdmin, refreshAdminSession } from './runtime/adminSession.js'
import { isNativeOverlaySurface } from './runtime/nativeSurfaceBridge.js'

const route = useRoute()
const router = useRouter()
const protectedPaths = new Set(['/', '/group', '/overlay', '/hud-preview', '/customer'])
const isNativeOverlaySurfaceRoute = computed(() => isNativeOverlaySurface(
    route.query.embedded, route.query.surface, window.chrome?.webview))
const isNativeAdminSurfaceRoute = computed(() => route.query.embedded === 'unity'
    && route.query.surface !== 'overlay'
    && typeof window.chrome?.webview?.postMessage === 'function')
const nativeSessionIdentity = computed(() => {
    if (!isNativeAdminSurfaceRoute.value || !adminSession.ready || !adminSession.authenticated
        || !adminSession.permissions.launch || !adminSession.permissions.view) return ''
    return `${adminSession.accountSlotId}:${adminSession.user?.id || adminSession.user?.username || ''}`
})
const waitingForNativeOverlayAuth = computed(() => isNativeOverlaySurfaceRoute.value
    && adminSession.ready && !adminSession.authenticated)
const showPermissionDenied = computed(() => protectedPaths.has(route.path)
    && adminSession.authenticated && !adminSession.permissions.view && route.path !== '/customer')
const hasCustomerOperations = computed(() => adminSession.permissions.cast || adminSession.permissions.backup)
let overlayAuthPoll = 0
const originalDocumentBackground = document.documentElement.style.backgroundColor
const originalBodyBackground = document.body.style.backgroundColor

async function signOutFromDeniedPage() {
    await lockAdmin()
}

watch(() => adminSession.authenticated, authenticated => {
    if (!authenticated && protectedPaths.has(route.path)) {
        if (isNativeOverlaySurfaceRoute.value) return
        void router.replace({ path: '/admin', query: { redirect: route.fullPath } })
    }
})

watch(waitingForNativeOverlayAuth, waiting => {
    window.clearInterval(overlayAuthPoll)
    overlayAuthPoll = 0
    if (waiting) {
        overlayAuthPoll = window.setInterval(() => { void refreshAdminSession() }, 1500)
        // The host's reload cover waits for both overlay_ready and hit regions.
        // This transparent auth-wait shell intentionally has no UI, so report
        // the empty surface explicitly instead of leaving the cover stuck over
        // Unity's native login screen.
        void nextTick(() => {
            const webview = window.chrome?.webview
            if (!webview) return
            webview.postMessage({ type: 'host_action', action: 'show_admin', returnToDashboard: true })
            webview.postMessage({ type: 'overlay_regions', viewport: { width: innerWidth, height: innerHeight }, regions: [] })
            webview.postMessage({ type: 'overlay_ready' })
        })
    }
}, { immediate: true })

let nativeSessionSyncGeneration = 0
watch(nativeSessionIdentity, async identity => {
    const generation = ++nativeSessionSyncGeneration
    if (!isNativeAdminSurfaceRoute.value || !adminSession.ready) return
    const webview = window.chrome?.webview
    if (!identity) {
        webview?.postMessage({ type: 'host_action', action: 'clear_unity_session' })
        return
    }
    // Session polling replaces the permissions object every ten seconds. A
    // watch on its object identity re-issued a one-time ticket each poll and
    // restarted Unity's scene loading indefinitely. The account identity is
    // stable during refreshes; retry only genuine handoff failures.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const ticket = await issueNativeSessionTicket()
            if (generation !== nativeSessionSyncGeneration || nativeSessionIdentity.value !== identity) return
            webview?.postMessage({ type: 'host_action', action: 'sync_unity_session', ticket })
            return
        } catch (error) {
            if (generation !== nativeSessionSyncGeneration) return
            if (attempt === 2) console.warn('[NativeSession] Unity session handoff could not be issued:', error.message)
            else await new Promise(resolve => window.setTimeout(resolve, 400 * (attempt + 1)))
        }
    }
}, { immediate: true })

watch(isNativeOverlaySurfaceRoute, isOverlay => {
    document.documentElement.style.backgroundColor = isOverlay ? 'transparent' : originalDocumentBackground
    document.body.style.backgroundColor = isOverlay ? 'transparent' : originalBodyBackground
}, { immediate: true })

onMounted(() => { void refreshAdminSession() })
onUnmounted(() => window.clearInterval(overlayAuthPoll))
</script>

<template>
    <main v-if="waitingForNativeOverlayAuth" class="native-overlay-auth-wait" aria-hidden="true"></main>
    <main v-else-if="showPermissionDenied" class="access-gate access-denied">
        <section class="access-card" aria-labelledby="denied-title">
            <div class="access-mark access-mark-denied" aria-hidden="true"><i></i><i></i><i></i></div>
            <p class="access-eyebrow">ACCOUNT PERMISSIONS</p>
            <h1 id="denied-title">此账户没有大屏查看权限</h1>
            <p class="access-copy">请联系系统管理员调整您的功能权限。当前账号仅能访问已获授权的现场操作。</p>
            <button v-if="hasCustomerOperations" type="button" class="denied-action" @click="router.replace({ path: '/customer', query: route.query })">进入现场操作中心<span aria-hidden="true">→</span></button>
            <button v-else type="button" class="denied-action" @click="signOutFromDeniedPage">退出当前账户<span aria-hidden="true">→</span></button>
        </section>
    </main>
    <RouterView v-else v-slot="{ Component, route: activeRoute }">
        <Transition name="route-fade" mode="out-in">
            <KeepAlive include="AdminAccess">
                <component
                    :is="Component"
                    :key="activeRoute.meta.keepAlive || activeRoute.meta.stableInstance ? activeRoute.name : activeRoute.fullPath"
                />
            </KeepAlive>
        </Transition>
    </RouterView>
</template>

<style>
.native-overlay-auth-wait{position:fixed;inset:0;background:transparent;pointer-events:none}
.access-gate{position:fixed;z-index:2147483000;inset:0;display:grid;place-items:center;overflow:auto;padding:32px;background:#f0f1ef;color:#252923;font-family:Inter,"Segoe UI","Microsoft YaHei UI",sans-serif;isolation:isolate}
.access-gate::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 44%,rgba(255,255,255,.96),rgba(240,241,239,.98) 66%),linear-gradient(135deg,#eeefec,#e9eae7);pointer-events:none}
.access-card{position:relative;box-sizing:border-box;width:min(100%,460px);padding:42px 44px 27px;border:1px solid rgba(72,76,67,.12);border-radius:17px;background:rgba(250,250,248,.94);box-shadow:0 24px 70px rgba(46,48,41,.12),inset 0 1px rgba(255,255,255,.9);backdrop-filter:blur(18px)}
.access-denied .access-card{width:min(100%,520px)}.access-denied h1{font-size:21px;line-height:1.5}.access-mark-denied i{background:linear-gradient(180deg,#c9a981,#8c7760)}.denied-action{display:flex;align-items:center;justify-content:space-between;width:100%;height:44px;margin-top:10px;padding:0 15px;border:1px solid #55574d;border-radius:7px;background:rgba(65,67,59,.94);color:#f4f2ea;font:inherit;font-size:12px;cursor:pointer;transition:background .18s ease,transform .18s ease}.denied-action:hover{transform:translateY(-1px);background:#505247}
.access-mark{display:flex;align-items:center;gap:4px;width:48px;height:42px;margin-bottom:26px}.access-mark i{display:block;width:9px;border-radius:8px;background:linear-gradient(180deg,#bab39d,#77766d)}.access-mark i:nth-child(1){height:19px;opacity:.55}.access-mark i:nth-child(2){height:33px}.access-mark i:nth-child(3){height:25px;opacity:.75}
.access-eyebrow{margin:0 0 9px;color:#89897e;font-size:9px;letter-spacing:.19em}.access-card h1{margin:0;color:#2d302a;font-size:25px;font-weight:560;letter-spacing:.025em}.access-copy{margin:12px 0 27px;color:#77786f;font-size:12px;line-height:1.8}
@media(max-width:520px){.access-gate{padding:18px}.access-card{padding:32px 25px 22px}}
</style>
