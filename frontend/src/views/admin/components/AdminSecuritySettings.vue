<script setup>
import { ref, watch } from 'vue'
import { adminSession, saveAdminSecuritySettings, changeAdminPassword, lockAdmin } from '../../../runtime/adminSession.js'

const idleMinutes = ref(adminSession.idleTimeoutMinutes)
const saving = ref(false)
const changingPassword = ref(false)
const message = ref('')
const failed = ref(false)
const policyMessage = ref('')
const policyFailed = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
watch(() => adminSession.idleTimeoutMinutes, value => { idleMinutes.value = value })

async function savePolicy() {
    policyMessage.value = ''
    policyFailed.value = false
    if (!Number.isInteger(idleMinutes.value) || idleMinutes.value < 1 || idleMinutes.value > 480) {
        policyFailed.value = true
        policyMessage.value = '请输入 1–480 分钟的整数'
        return
    }
    saving.value = true
    try {
        await saveAdminSecuritySettings(idleMinutes.value)
        policyMessage.value = `保存成功：${idleMinutes.value} 分钟无操作后自动锁定。`
    } catch (error) {
        policyFailed.value = true
        policyMessage.value = error.message || '保存失败，请稍后重试'
    } finally { saving.value = false }
}

async function savePassword() {
    message.value = ''
    failed.value = false
    if (newPassword.value !== confirmPassword.value) {
        failed.value = true
        message.value = '两次输入的新密码不一致'
        return
    }
    changingPassword.value = true
    try {
        await changeAdminPassword(currentPassword.value, newPassword.value)
        currentPassword.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
        message.value = '后台密码已修改；当前窗口保持解锁，其他工程师会话已失效。'
    } catch (error) {
        failed.value = true
        message.value = error.message
    } finally { changingPassword.value = false }
}
</script>

<template>
    <section class="security-settings" aria-labelledby="admin-security-title">
        <div class="security-heading">
            <div>
                <h3 id="admin-security-title">后台安全</h3>
                <p>普通用户只能查看大屏，修改配置需要工程师密码。</p>
            </div>
            <span class="unlocked-badge">工程师已解锁</span>
        </div>

        <div class="security-grid">
            <form class="security-card" @submit.prevent="savePolicy">
                <h4>无操作自动锁定</h4>
                <p>解锁后反复进入后台无需重复输入密码；超过设定时间没有操作，会自动收回修改权限。</p>
                <label for="admin-idle-minutes">自动锁定时间（分钟）</label>
                <div class="timeout-input-row">
                    <input id="admin-idle-minutes" v-model.number="idleMinutes" type="number" min="1" max="480" step="1" required :disabled="saving" />
                    <span>分钟无操作后锁定</span>
                </div>
                <div class="timeout-presets" aria-label="常用自动锁定时间">
                    <button v-for="minutes in [5, 15, 30, 60, 120]" :key="minutes" type="button" :class="{ selected: idleMinutes === minutes }" :disabled="saving" @click="idleMinutes = minutes">{{ minutes }} 分钟</button>
                </div>
                <p class="security-note">可设置 1–480 分钟，当前生效：{{ adminSession.idleTimeoutMinutes }} 分钟。数据刷新、设备动画和后台轮询不计为人工操作。</p>
                <p class="security-note">单次解锁最长 {{ adminSession.maxSessionHours }} 小时；重启软件后需要重新输入密码。</p>
                <div class="security-action-row">
                    <button type="submit" class="security-primary" :disabled="saving" :aria-busy="saving">
                        <svg v-if="saving" class="button-status-icon is-spinning" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 1 1-5.2 2.3" /></svg>
                        <svg v-else-if="policyMessage && !policyFailed" class="button-status-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.2 3.4 3.4 7.6-7.2" /></svg>
                        {{ saving ? '保存中…' : '保存自动锁定设置' }}
                    </button>
                    <span v-if="policyMessage" class="security-inline-message" :class="{ failed: policyFailed }" role="status" aria-live="polite">
                        <svg viewBox="0 0 20 20" aria-hidden="true"><path v-if="policyFailed" d="M10 6v4m0 3h.01M10 2.8 18 17H2z" /><path v-else d="m4.5 10.2 3.4 3.4 7.6-7.2" /></svg>
                        {{ policyMessage }}
                    </span>
                </div>
            </form>

            <div class="security-card lock-card">
                <span class="lock-symbol" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>
                </span>
                <h4>离开前，立即锁定</h4>
                <p>立即锁定所有已解锁的后台窗口。实时大屏继续显示，重新进入后台需要密码。</p>
                <p class="security-note">请先保存正在编辑的内容，锁定会关闭后台编辑界面。顶部也始终提供“立即锁定”入口。</p>
                <button type="button" class="security-lock" @click="lockAdmin">立即锁定</button>
            </div>
        </div>

        <form class="security-card password-card" @submit.prevent="savePassword">
            <h4>修改后台密码</h4>
            <p>修改前需要验证原密码。请使用 8–128 个字符的密码，并只交给负责配置的工程师。</p>
            <div class="password-fields">
                <label>原后台密码<input v-model="currentPassword" type="password" autocomplete="current-password" minlength="8" maxlength="128" required /></label>
                <label>新后台密码<input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label>
                <label>确认新密码<input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label>
            </div>
            <button type="submit" class="security-secondary" :disabled="changingPassword">{{ changingPassword ? '修改中…' : '修改后台密码' }}</button>
        </form>
        <p v-if="message" class="security-message" :class="{ failed }" role="status">{{ message }}</p>
    </section>
</template>

<style scoped>
.security-settings { color: #1d2939; padding: 24px 0; }
.security-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 22px; }
h3 { margin: 0 0 8px; font-size: 21px; }
h4 { margin: 0 0 12px; font-size: 17px; }
p { color: #667085; font-size: 13px; line-height: 1.8; margin: 0 0 16px; }
.unlocked-badge { color: #067647; background: #ecfdf3; border: 1px solid #abefc6; padding: 6px 12px; border-radius: 20px; font-size: 12px; white-space: nowrap; }
.security-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 20px; }
.security-card { padding: 24px; background: #fff; border: 1px solid #e4e7ec; border-radius: 14px; }
label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #344054; }
input { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid #d0d5dd; border-radius: 8px; padding: 10px 12px; font: inherit; background: #fff; color: #1d2939; }
input:focus { outline: 2px solid #84caff; outline-offset: 1px; }
button { cursor: pointer; border-radius: 8px; padding: 10px 16px; font: inherit; font-size: 13px; font-weight: 600; transition: transform .18s cubic-bezier(.22,1,.36,1), color .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease; }
button:disabled { cursor: wait; opacity: .55; }
.timeout-input-row { display: flex; align-items: center; gap: 12px; margin: 10px 0 12px; color: #667085; font-size: 13px; }
.timeout-input-row input { width: 110px; }
.timeout-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.timeout-presets button, .security-secondary { border: 1px solid #d0d5dd; background: #fff; color: #344054; }
.timeout-presets button { padding: 6px 10px; font-size: 12px; }
.timeout-presets button:hover:not(:disabled), .security-secondary:hover:not(:disabled) { color: #174ea6; border-color: #8bb8f8; background: #f7faff; transform: translateY(-1px); box-shadow: 0 6px 14px rgba(37,99,235,.1); }
.timeout-presets button.selected { color: #174ea6; border-color: #60a5fa; background: #eef5ff; box-shadow: 0 0 0 3px rgba(37,99,235,.1), 0 5px 12px rgba(37,99,235,.08); }
.security-note { font-size: 12px; }
.security-action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
.security-primary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.button-status-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.button-status-icon.is-spinning { animation: securityButtonSpin .8s linear infinite; }
.security-inline-message { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 7px 10px; border: 1px solid #abefc6; border-radius: 8px; color: #067647; background: linear-gradient(135deg, #f0fdf4 0%, #dcfae6 100%); font-size: 12px; line-height: 1.45; }
.security-inline-message.failed { border-color: #fecdca; color: #b42318; background: linear-gradient(135deg, #fff8f7 0%, #fef3f2 100%); }
.security-inline-message svg { width: 15px; height: 15px; flex: 0 0 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
@keyframes securityButtonSpin { to { transform: rotate(360deg); } }
.security-primary { background: linear-gradient(135deg, #4f8df7 0%, #2563eb 56%, #1d4ed8 100%); border: 1px solid #2563eb; color: #fff; box-shadow: 0 5px 12px rgba(37,99,235,.18); }
.security-primary:hover:not(:disabled) { background: linear-gradient(135deg, #63a4ff 0%, #1d4ed8 62%, #1e40af 100%); border-color: #1d4ed8; transform: translateY(-2px); box-shadow: 0 9px 20px rgba(37,99,235,.24); }
.security-lock { background: linear-gradient(135deg, #475467 0%, #1d2939 100%); border: 1px solid #344054; color: #fff; box-shadow: 0 5px 12px rgba(52,64,84,.16); }
.security-lock:hover:not(:disabled) { background: linear-gradient(135deg, #667085 0%, #182230 100%); border-color: #1d2939; transform: translateY(-2px); box-shadow: 0 9px 20px rgba(52,64,84,.22); }
.lock-symbol { display: grid; place-items: center; width: 44px; height: 44px; color: #344054; background: #f2f4f7; border-radius: 12px; margin-bottom: 16px; }
.lock-symbol svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
.password-card { margin-top: 20px; }
.password-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-bottom: 20px; }
.security-message { margin-top: 16px; padding: 12px 16px; background: #ecfdf3; color: #067647; border-radius: 8px; }
.security-message.failed { color: #b42318; background: #fef3f2; }
@media (max-width: 1000px) { .security-grid, .password-fields { grid-template-columns: 1fr; } }
</style>
