<script setup>
import { computed, reactive, onMounted, onUnmounted, watch } from 'vue'
import { adminSession } from '../../../runtime/adminSession.js'

const emit = defineEmits(['state', 'before-dashboard'])

const isUnityEmbedded = new URLSearchParams(window.location.search).get('embedded') === 'unity'
const unityHostState = reactive({ attached: true, maximized: false, dockReady: false, adminVisible: true })
const isAdminLocked = computed(() => adminSession.ready && !adminSession.authenticated)
let unityHostDragActive = false
let unityHostDragTarget = 'admin'
let unityHostDragStartX = 0
let unityHostDragStartY = 0
const UNITY_NATIVE_MOVE_THRESHOLD = 5

function postUnityHostMessage(message) {
    window.chrome?.webview?.postMessage(message)
}

function handleUnityHostMessage(event) {
    if (event.data?.type !== 'host_state') return
    unityHostState.attached = event.data.attached !== false
    unityHostState.maximized = event.data.maximized === true
    unityHostState.dockReady = event.data.dockReady === true
    unityHostState.adminVisible = event.data.adminVisible !== false
}

function requestUnityHostAction(action) {
    postUnityHostMessage({ type: 'host_action', action })
}

function handleUnityChromeDoubleClick(event) {
    if (event.button !== 0) return
    if (event.target?.closest?.('.unity-browser-tab, .unity-window-actions')) return
    unityHostDragActive = false
    requestUnityHostAction('maximize')
}

function beginUnityHostDrag(event, target = 'admin') {
    if (event.button !== 0) return
    if (!unityHostState.attached) {
        postUnityHostMessage({
            type: 'host_drag_start',
            target: 'admin',
            screenX: Math.round(event.screenX),
            screenY: Math.round(event.screenY)
        })
        return
    }
    unityHostDragActive = true
    unityHostDragTarget = target
    unityHostDragStartX = event.screenX
    unityHostDragStartY = event.screenY
    event.currentTarget?.setPointerCapture?.(event.pointerId)
    if (target === 'dashboard') return
    postUnityHostMessage({
        type: 'host_drag_start',
        target,
        screenX: Math.round(event.screenX),
        screenY: Math.round(event.screenY)
    })
}

function continueUnityHostDrag(event) {
    if (!unityHostDragActive) return
    if (unityHostDragTarget === 'dashboard') {
        const deltaX = event.screenX - unityHostDragStartX
        const deltaY = event.screenY - unityHostDragStartY
        if ((deltaX * deltaX) + (deltaY * deltaY) < UNITY_NATIVE_MOVE_THRESHOLD * UNITY_NATIVE_MOVE_THRESHOLD) return
        unityHostDragActive = false
        event.currentTarget?.releasePointerCapture?.(event.pointerId)
        postUnityHostMessage({
            type: 'host_window_move_start',
            screenX: Math.round(event.screenX),
            screenY: Math.round(event.screenY)
        })
        return
    }
    postUnityHostMessage({ type: 'host_drag_move', screenX: Math.round(event.screenX), screenY: Math.round(event.screenY) })
}

function endUnityHostDrag(event) {
    if (!unityHostDragActive) return
    const target = unityHostDragTarget
    unityHostDragActive = false
    unityHostDragTarget = 'admin'
    if (target === 'dashboard') return
    postUnityHostMessage({
        type: 'host_drag_end',
        screenX: Math.round(event?.screenX || 0),
        screenY: Math.round(event?.screenY || 0)
    })
}

if (isUnityEmbedded) {
    onMounted(() => {
        window.chrome?.webview?.addEventListener('message', handleUnityHostMessage)
        postUnityHostMessage({ type: 'host_action', action: 'state' })
    })
    onUnmounted(() => window.chrome?.webview?.removeEventListener('message', handleUnityHostMessage))
}

function closeAdminPanel() {
    if (isUnityEmbedded && window.chrome?.webview) {
        requestUnityHostAction('close_window')
        return
    }
    window.location.assign('/')
}

function showUnityDashboard() {
    emit('before-dashboard')
    requestUnityHostAction('show_dashboard')
}

function showUnityAdmin() {
    requestUnityHostAction('show_admin')
}

function reloadAdminPage() {
    if (isUnityEmbedded && window.chrome?.webview) {
        requestUnityHostAction('reload_page')
        return
    }
    window.location.reload()
}


watch(unityHostState, state => emit('state', { ...state }), { immediate: true })
</script>

<template>
<div
            v-if="isUnityEmbedded"
            class="unity-window-chrome"
            :class="{ 'is-dock-ready': unityHostState.dockReady, 'is-dashboard-tab': unityHostState.attached && !unityHostState.adminVisible }"
            @pointerdown="beginUnityHostDrag($event, 'dashboard')"
            @pointermove="continueUnityHostDrag"
            @pointerup="endUnityHostDrag"
            @pointercancel="endUnityHostDrag"
            @lostpointercapture="endUnityHostDrag"
            @dblclick="handleUnityChromeDoubleClick"
        >
            <div
                class="unity-tab-strip"
            >
                <button
                    v-if="unityHostState.attached"
                    type="button"
                    class="unity-browser-tab unity-screen-tab"
                    :class="{ 'is-active': !unityHostState.adminVisible }"
                    title="实时大屏"
                    @pointerdown.stop="beginUnityHostDrag($event, 'dashboard')"
                    @pointermove.stop="continueUnityHostDrag"
                    @pointerup.stop="endUnityHostDrag"
                    @pointercancel.stop="endUnityHostDrag"
                    @lostpointercapture.stop="endUnityHostDrag"
                    @click="showUnityDashboard"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
                        <path d="M8 20h8M12 16.5V20" />
                    </svg>
                    <span>实时大屏</span>
                </button>

                <div
                    class="unity-browser-tab unity-admin-tab"
                    :class="{ 'is-active': !unityHostState.attached || unityHostState.adminVisible }"
                    role="tab"
                    aria-selected="true"
                    title="后台管理"
                    @pointerdown.stop="beginUnityHostDrag($event, 'admin')"
                    @pointermove.stop="continueUnityHostDrag"
                    @pointerup.stop="endUnityHostDrag"
                    @pointercancel.stop="endUnityHostDrag"
                    @lostpointercapture.stop="endUnityHostDrag"
                    @click="showUnityAdmin"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
                        <circle cx="16" cy="7" r="2" />
                        <circle cx="8" cy="12" r="2" />
                        <circle cx="13" cy="17" r="2" />
                    </svg>
                    <span>后台管理</span>
                    <span v-if="isAdminLocked" class="unity-tab-lock" role="img" aria-label="后台已锁定" title="后台已锁定">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="5" y="10" width="14" height="11" rx="2" />
                            <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
                        </svg>
                    </span>
                    <i v-else class="unity-tab-online" aria-hidden="true"></i>
                </div>

            </div>

            <div class="unity-window-actions" @pointerdown.stop>
                <button
                    type="button"
                    class="unity-window-action"
                    title="刷新页面"
                    aria-label="刷新页面"
                    @click="reloadAdminPage"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19 8a7.5 7.5 0 1 0 .8 6.8" />
                        <path d="M19 4v4h-4" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action"
                    title="最小化"
                    aria-label="最小化窗口"
                    @click="requestUnityHostAction('minimize')"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 16.5h14" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action"
                    :title="unityHostState.maximized ? '还原' : '最大化'"
                    :aria-label="unityHostState.maximized ? '还原窗口' : '最大化窗口'"
                    @click="requestUnityHostAction('maximize')"
                >
                    <svg v-if="unityHostState.maximized" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="7" y="5" width="11" height="11" rx="1" />
                        <path d="M7 9H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="5" y="5" width="14" height="14" rx="1.5" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action is-close"
                    title="关闭软件"
                    aria-label="关闭软件"
                    @click="closeAdminPanel"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                </button>
            </div>
        </div>
</template>

<style scoped>
.unity-window-chrome {
    height: 46px;
    flex: 0 0 46px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 6px 0 8px;
    color: #344054;
    background: linear-gradient(180deg, #edf2f7 0%, #dfe7ef 100%);
    border-bottom: 1px solid #cbd5df;
    box-shadow: 0 2px 8px rgba(31, 50, 68, 0.14);
    cursor: grab;
    touch-action: none;
    user-select: none;
    z-index: 500;
}
.unity-window-chrome:active { cursor: grabbing; }
.unity-tab-strip {
    min-width: 0;
    flex: 1;
    align-self: stretch;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    overflow: hidden;
}
.unity-browser-tab {
    height: 35px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 10px 10px 0 0;
    color: #475467;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
}
.unity-browser-tab svg,
.unity-window-action svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.unity-screen-tab {
    background: transparent;
    cursor: grab;
    touch-action: none;
    transition: color 0.16s ease, background 0.16s ease;
}
.unity-screen-tab:active { cursor: grabbing; }
.unity-screen-tab:hover {
    color: #175cd3;
    background: rgba(255, 255, 255, 0.58);
}
.unity-admin-tab {
    min-width: 178px;
    background: transparent;
    cursor: grab;
    touch-action: none;
    position: relative;
    transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.unity-admin-tab:hover { background: rgba(255, 255, 255, 0.58); }
.unity-admin-tab:active { cursor: grabbing; }
.unity-browser-tab.is-active {
    color: #172b3f;
    background: #f8fafc;
    border-color: #cbd5df;
    box-shadow: 0 -1px 4px rgba(27, 45, 63, 0.08);
}
.unity-browser-tab.is-active::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: -1px;
    height: 2px;
    background: #f8fafc;
}
.unity-screen-tab { position: relative; }
.unity-window-chrome.is-dashboard-tab .unity-screen-tab.is-active {
    margin-bottom: 4px;
    border-bottom: 1px solid #cbd5df;
    border-radius: 10px;
    box-shadow: 0 1px 5px rgba(27, 45, 63, 0.14);
}
.unity-window-chrome.is-dashboard-tab .unity-screen-tab.is-active::after {
    display: none;
}
.unity-admin-tab > svg { color: #1570ef; }
.unity-window-chrome.is-dock-ready .unity-admin-tab {
    border-color: #6ce9a6;
    box-shadow: 0 -1px 0 #6ce9a6, 0 0 0 3px rgba(18, 183, 106, 0.1);
}
.unity-tab-online {
    width: 7px;
    height: 7px;
    margin-left: auto;
    border-radius: 50%;
    background: #12b76a;
    box-shadow: 0 0 0 3px rgba(18, 183, 106, 0.12);
}
.unity-tab-lock {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    margin-left: auto;
    border-radius: 5px;
    color: #667085;
    background: rgba(102, 112, 133, 0.1);
}
.unity-tab-lock svg {
    width: 14px;
    height: 14px;
    stroke-width: 1.8;
}
.unity-window-actions {
    height: 35px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    align-self: flex-start;
    margin-top: -6px;
    margin-left: 8px;
    min-width: 160px;
}
.unity-window-action {
    width: 40px;
    flex: 0 0 40px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 7px;
    color: #475467;
    background: transparent;
    cursor: pointer;
    transition: color 0.16s ease, background 0.16s ease;
}
.unity-window-action:hover {
    color: #172b3f;
    background: rgba(75, 98, 120, 0.13);
}
.unity-window-action.is-close:hover {
    color: #fff;
    background: #e5484d;
}
</style>
