import { reactive } from 'vue'
import { API_BASE } from './backendEndpoint.js'

export const adminSession = reactive({
    ready: false,
    configured: true,
    authenticated: false,
    idleTimeoutMinutes: 30,
    maxSessionHours: 8,
    expiresAt: 0,
    lockPending: false,
    warning: ''
})

// Credentials stay in an HttpOnly cookie. Only the anti-CSRF value is held in
// memory; neither the password nor a login flag/token is saved in Web Storage.
let csrfToken = ''
let generation = 0
let refreshPromise = null
let channel = null
let trackingStarted = false
let pendingLock = false
let pendingLockCsrf = ''
let lastPollAt = 0
let lastTouchAt = 0
let touchTimer = null
let lockPromise = null
let pollTimer = null
let activityHandler = null

function applySession(data, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return
    adminSession.ready = true
    adminSession.configured = data.configured !== false
    adminSession.authenticated = data.authenticated === true
    adminSession.idleTimeoutMinutes = data.idleTimeoutMinutes || 30
    adminSession.maxSessionHours = data.maxSessionHours || 8
    adminSession.expiresAt = data.expiresAt || 0
    csrfToken = data.authenticated ? data.csrfToken || '' : ''
    adminSession.warning = ''
}

function clearSession(message = '') {
    generation += 1
    csrfToken = ''
    adminSession.authenticated = false
    adminSession.expiresAt = 0
    adminSession.warning = message
    window.clearTimeout(touchTimer)
    touchTimer = null
}

async function authRequest(path, { method = 'GET', body } = {}, csrf = csrfToken) {
    const requestGeneration = generation
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 10000)
    try {
        const response = await window.fetch(`${API_BASE}/admin-auth${path}`, {
            method,
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
                'X-Admin-Request': '1',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(csrf ? { 'X-CSRF-Token': csrf } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok && data.code === 'ADMIN_AUTH_REQUIRED' && requestGeneration === generation) clearSession('后台会话已失效，请重新输入密码')
        if (!response.ok) throw Object.assign(new Error(data.error || '后台安全服务暂不可用'), {
            code: data.code,
            status: response.status,
            retryAfterSeconds: Number(data.retryAfterSeconds || response.headers.get('Retry-After')) || 0
        })
        return data
    } catch (error) {
        if (error.name === 'AbortError' || error instanceof TypeError) {
            throw new Error('无法连接后台安全服务，请检查服务状态后重试')
        }
        throw error
    } finally {
        window.clearTimeout(timer)
    }
}

function broadcast(type, warning = '') {
    channel?.postMessage({ type, warning })
}

function confirmPendingLock() {
    if (lockPromise) return lockPromise
    lockPromise = performPendingLock().finally(() => { lockPromise = null })
    return lockPromise
}

async function performPendingLock() {
    try {
        // A concurrent window may have renewed the cookie before the lock request.
        const current = await authRequest('/session')
        await authRequest('/lock', { method: 'POST' }, current.csrfToken || pendingLockCsrf)
        pendingLock = false
        adminSession.lockPending = false
        pendingLockCsrf = ''
        adminSession.warning = ''
        adminSession.ready = true
        broadcast('locked')
        return true
    } catch (error) {
        if (error.status === 401 && error.code === 'ADMIN_AUTH_REQUIRED') {
            // An expired cookie cannot revoke another window's active session.
            // A definitive refusal must allow re-authentication; network failures
            // remain pending and fail closed until the server can confirm a lock.
            pendingLock = false
            adminSession.lockPending = false
            pendingLockCsrf = ''
            adminSession.warning = error.message
            broadcast('lock-rejected', error.message)
            return false
        }
        adminSession.warning = '页面已锁定，但服务器尚未确认。请恢复连接并点击“重试锁定”，确认成功后再离开。'
        return false
    }
}

export async function refreshAdminSession() {
    if (refreshPromise) return refreshPromise
    const expectedGeneration = generation
    refreshPromise = (async () => {
        if (pendingLock) return confirmPendingLock()
        try {
            const data = await authRequest('/session')
            applySession(data, expectedGeneration)
            return data
        } catch (error) {
            if (expectedGeneration === generation) {
                clearSession(error.message)
                adminSession.ready = true
            }
            return null
        }
    })().finally(() => { refreshPromise = null })
    return refreshPromise
}

export async function unlockAdmin(password, setup = false) {
    if (pendingLock && !(await confirmPendingLock()) && pendingLock) throw new Error(adminSession.warning)
    const expectedGeneration = ++generation
    const data = await authRequest(setup ? '/setup' : '/login', { method: 'POST', body: { password } })
    applySession(data, expectedGeneration)
    lastTouchAt = Date.now()
    broadcast('changed')
}

export async function lockAdmin() {
    pendingLockCsrf = csrfToken || pendingLockCsrf
    pendingLock = true
    adminSession.lockPending = true
    clearSession()
    broadcast('lock-pending')
    return confirmPendingLock()
}

export async function saveAdminSecuritySettings(idleTimeoutMinutes) {
    const expectedGeneration = generation
    const data = await authRequest('/settings', { method: 'PUT', body: { idleTimeoutMinutes } })
    applySession(data, expectedGeneration)
    broadcast('changed')
}

export async function changeAdminPassword(currentPassword, newPassword) {
    const expectedGeneration = generation
    const data = await authRequest('/password', { method: 'PUT', body: { currentPassword, newPassword } })
    applySession(data, expectedGeneration)
    broadcast('changed')
}

export async function adminFetch(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href)
    const backend = new URL(API_BASE)
    if (url.origin !== backend.origin || !url.pathname.startsWith('/api/')) return window.fetch(input, options)
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined))
    const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken)
    const expectedGeneration = generation
    const response = await window.fetch(input, { ...options, headers, credentials: 'include' })
    if (response.status === 401) {
        const data = await response.clone().json().catch(() => ({}))
        if (data.code === 'ADMIN_AUTH_REQUIRED' && generation === expectedGeneration) clearSession('后台会话已失效，请重新输入密码')
    }
    return response
}

function workspaceIsVisible() {
    const workspace = document.querySelector('[data-admin-workspace]')
    return document.visibilityState !== 'hidden' && !!workspace && !workspace.classList.contains('unity-dashboard-tab')
}

async function touchSession() {
    touchTimer = null
    if (!adminSession.authenticated || pendingLock || !workspaceIsVisible()) return
    const expectedGeneration = generation
    lastTouchAt = Date.now()
    try {
        const data = await authRequest('/touch', { method: 'POST' })
        applySession(data, expectedGeneration)
    } catch (error) {
        if (generation === expectedGeneration) clearSession(error.message)
    }
}

export function startAdminSessionTracking() {
    if (trackingStarted) return stopAdminSessionTracking
    trackingStarted = true
    if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('digital-twin-admin-access')
        channel.onmessage = ({ data }) => {
            if (data?.type === 'lock-pending') {
                pendingLockCsrf = csrfToken || pendingLockCsrf
                pendingLock = true
                adminSession.lockPending = true
                clearSession()
            } else if (data?.type === 'locked' || data?.type === 'lock-rejected') {
                pendingLock = false
                pendingLockCsrf = ''
                adminSession.lockPending = false
                clearSession(data.type === 'lock-rejected' ? String(data.warning || '请重新解锁后再次锁定后台') : '')
            }
            else if (data?.type === 'changed') refreshAdminSession()
        }
    }
    activityHandler = event => {
        if (!event.isTrusted || !adminSession.authenticated || !workspaceIsVisible()) return
        if (Date.now() - lastTouchAt >= 10000) touchSession()
        else if (!touchTimer) touchTimer = window.setTimeout(touchSession, 10000 - (Date.now() - lastTouchAt))
    }
    for (const eventName of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
        window.addEventListener(eventName, activityHandler, { capture: true, passive: true })
    }
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    pollTimer = window.setInterval(() => {
        const now = Date.now()
        if ((adminSession.authenticated || pendingLock) && (now - lastPollAt >= 10000 || now >= adminSession.expiresAt)) {
            lastPollAt = now
            refreshAdminSession()
        }
    }, 1000)
    return stopAdminSessionTracking
}

function handleWindowFocus() {
    refreshAdminSession()
}

function handleVisibilityChange() {
    if (document.visibilityState === 'visible') refreshAdminSession()
}

export function stopAdminSessionTracking() {
    if (!trackingStarted) return
    trackingStarted = false
    for (const eventName of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
        window.removeEventListener(eventName, activityHandler, { capture: true })
    }
    window.removeEventListener('focus', handleWindowFocus)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.clearInterval(pollTimer)
    window.clearTimeout(touchTimer)
    pollTimer = null
    touchTimer = null
    activityHandler = null
    channel?.close()
    channel = null
}
