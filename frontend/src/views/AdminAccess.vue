<script setup>
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { adminSession, refreshAdminSession, startAdminSessionTracking, stopAdminSessionTracking, unlockAdmin, lockAdmin } from '../runtime/adminSession.js'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'

defineOptions({ name: 'AdminAccess' })
const AdminPanel = defineAsyncComponent(() => import('./AdminPanel.vue'))
const isUnityEmbedded = new URLSearchParams(window.location.search).get('embedded') === 'unity'
const hostState = reactive({ attached: true, adminVisible: true })
const password = ref('')
const confirmation = ref('')
const passwordInput = ref(null)
const busy = ref(false)
const error = ref('')
const retryAt = ref(0)
const now = ref(Date.now())
const retrySeconds = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)))
const setup = computed(() => adminSession.ready && !adminSession.configured)
let clockTimer = null

function startClock() {
    if (!clockTimer) clockTimer = window.setInterval(() => { now.value = Date.now() }, 500)
}

function stopClock() {
    window.clearInterval(clockTimer)
    clockTimer = null
}

async function focusPassword() {
    await nextTick()
    if (passwordInput.value?.isConnected) passwordInput.value.focus()
}

async function submit() {
    if (busy.value || retrySeconds.value > 0) return
    error.value = ''
    if (setup.value && password.value !== confirmation.value) {
        error.value = '两次输入的后台密码不一致'
        return
    }
    busy.value = true
    try {
        await unlockAdmin(password.value, setup.value)
        password.value = ''
        confirmation.value = ''
    } catch (caught) {
        error.value = caught.message
        retryAt.value = Date.now() + (caught.retryAfterSeconds || 0) * 1000
        password.value = ''
        if (caught.code === 'ADMIN_ALREADY_CONFIGURED' || caught.code === 'ADMIN_SETUP_REQUIRED') await refreshAdminSession()
        focusPassword()
    } finally { busy.value = false }
}

watch(() => adminSession.authenticated, authenticated => {
    password.value = ''
    confirmation.value = ''
    error.value = ''
    if (!authenticated) focusPassword()
})
watch(() => hostState.adminVisible, visible => { if (visible) refreshAdminSession() })
onMounted(async () => {
    startAdminSessionTracking()
    startClock()
    await refreshAdminSession()
    focusPassword()
})
onActivated(() => { startClock(); refreshAdminSession() })
onDeactivated(stopClock)
onUnmounted(() => { stopClock(); stopAdminSessionTracking() })
</script>

<template>
    <div class="admin-access-root">
        <AdminPanel v-if="adminSession.authenticated" />
        <div v-else class="admin-locked-shell">
            <AdminWindowChrome v-if="isUnityEmbedded" @state="Object.assign(hostState, $event)" />
            <main v-show="!isUnityEmbedded || !hostState.attached || hostState.adminVisible" class="admin-unlock-page">
                <section class="admin-unlock-card" aria-labelledby="admin-unlock-title">
                    <div class="unlock-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></div>
                    <h1 id="admin-unlock-title">{{ !adminSession.ready ? '正在检查后台权限' : setup ? '设置后台密码' : '后台已锁定' }}</h1>
                    <p v-if="!adminSession.ready" class="unlock-description" role="status">正在连接后台安全服务…</p>
                    <p v-else-if="setup" class="unlock-description">首次使用请由工程师设置后台密码，再将软件交给普通用户。设置完成后，只有知道密码的人才能修改配置。</p>
                    <form v-if="adminSession.ready" @submit.prevent="submit">
                        <label for="admin-unlock-password">{{ setup ? '设置后台密码' : '后台密码' }}</label>
                        <input id="admin-unlock-password" ref="passwordInput" v-model="password" type="password" :autocomplete="setup ? 'new-password' : 'current-password'" minlength="8" maxlength="128" required :disabled="busy" :placeholder="setup ? '请设置 8–128 个字符的密码' : '请输入后台密码'" />
                        <template v-if="setup">
                            <label for="admin-unlock-confirm">确认后台密码</label>
                            <input id="admin-unlock-confirm" v-model="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required :disabled="busy" placeholder="请再次输入后台密码" />
                        </template>
                        <p v-if="error" class="unlock-error" role="alert">{{ error }}<span v-if="retrySeconds">（{{ retrySeconds }} 秒后重试）</span></p>
                        <button type="submit" class="unlock-submit" :disabled="busy || retrySeconds > 0">{{ busy ? '正在验证…' : setup ? '设置密码并进入后台' : '解锁后台' }}</button>
                    </form>
                    <div v-if="adminSession.warning" class="unlock-warning" role="alert">
                        <p>{{ adminSession.warning }}</p>
                        <button type="button" @click="adminSession.lockPending ? lockAdmin() : refreshAdminSession()">{{ adminSession.lockPending ? '重试锁定' : '重新检查连接' }}</button>
                    </div>
                </section>
            </main>
        </div>
    </div>
</template>

<style scoped>
.admin-access-root, .admin-locked-shell { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; }
.admin-unlock-page { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 32px 20px; background: #f4f6f9; color: #1d2939; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.admin-unlock-card { box-sizing: border-box; width: min(100%, 460px); padding: 32px; background: rgba(255,255,255,.92); border: 1px solid #dfe5ee; border-radius: 20px; box-shadow: 0 18px 44px rgba(16,24,40,.1), 0 2px 5px rgba(16,24,40,.04); backdrop-filter: blur(16px); }
.unlock-icon { width: 52px; height: 52px; background: #eff4fb; color: #344054; display: grid; place-items: center; border-radius: 14px; margin-bottom: 20px; }
.unlock-icon svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
h1 { margin: 0 0 12px; font-size: 24px; font-weight: 650; }
.unlock-description { color: #667085; font-size: 14px; line-height: 1.8; margin: 0 0 24px; }
label { display: block; color: #344054; font-size: 13px; margin: 16px 0 8px; }
input { width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid #d0d5dd; border-radius: 9px; font: inherit; font-size: 14px; color: #1d2939; background: #fff; }
input:focus { outline: 2px solid #84caff; outline-offset: 2px; }
button { font: inherit; cursor: pointer; }
button:disabled { opacity: .6; cursor: wait; }
.unlock-submit { width: 100%; padding: 12px; margin-top: 24px; border: 1px solid #1d2939; border-radius: 9px; background: linear-gradient(135deg, #344054 0%, #182230 100%); color: #fff; font-size: 14px; font-weight: 600; box-shadow: 0 6px 14px rgba(29,41,57,.18); transition: transform .18s cubic-bezier(.22,1,.36,1), background .18s ease, box-shadow .18s ease; }
.unlock-submit:not(:disabled):hover { background: linear-gradient(135deg, #475467 0%, #101828 100%); transform: translateY(-2px); box-shadow: 0 10px 22px rgba(29,41,57,.24); }
.unlock-submit:not(:disabled):active { transform: translateY(0) scale(.985); }
.unlock-error, .unlock-warning { color: #b42318; font-size: 13px; line-height: 1.7; }
.unlock-warning { margin-top: 16px; padding: 12px; border-radius: 8px; background: #fffaeb; color: #93370d; }
.unlock-warning p { margin: 0 0 8px; }
.unlock-warning button { padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; }
@media (max-width: 480px) { .admin-unlock-card { padding: 24px; } .admin-unlock-page { padding: 16px; } }
</style>
