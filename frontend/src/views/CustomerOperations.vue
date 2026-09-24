<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { adminApi } from '../config/factoryConfig.js'
import { adminSession, startAdminSessionTracking, stopAdminSessionTracking, lockAdmin } from '../runtime/adminSession.js'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'

const route = useRoute()
const router = useRouter()
const castDevices = ref([])
const selectedDeviceId = ref('')
const castStatus = ref(null)
const databaseBackups = ref([])
const siteBackups = ref([])
const busy = ref('')
const message = ref('')
const failure = ref(false)
const canCast = computed(() => adminSession.permissions.cast)
const canBackup = computed(() => adminSession.permissions.backup)
const embedded = computed(() => route.query.embedded === 'unity')

function showResult(text, isFailure = false) {
    message.value = text
    failure.value = isFailure
}

async function perform(key, task, successText) {
    if (busy.value) return
    busy.value = key
    message.value = ''
    try {
        const result = await task()
        if (result?.error || result?.success === false) throw new Error(result.error || '操作失败')
        if (result?.cast) castStatus.value = result.cast
        showResult(successText)
        return result
    } catch (error) {
        showResult(error.message || '操作失败，请重试', true)
    } finally {
        busy.value = ''
    }
}

async function loadCastDevices(refresh = false) {
    const result = await perform('cast-refresh', () => refresh ? adminApi.refreshCastDevices() : adminApi.getCastDevices(), '')
    if (!result) return
    castDevices.value = result.devices || []
    castStatus.value = result.cast || castStatus.value
    if (!castDevices.value.some(device => device.id === selectedDeviceId.value)) selectedDeviceId.value = castDevices.value[0]?.id || ''
    if (result.error) showResult(result.error, true)
}

async function startCasting() {
    const result = await perform('cast-start', () => adminApi.startCast(selectedDeviceId.value), '已开始投屏')
    if (result?.cast) castStatus.value = result.cast
}

async function stopCasting() {
    const result = await perform('cast-stop', () => adminApi.stopCast(), '投屏已停止')
    if (result?.cast) castStatus.value = result.cast
}

async function loadBackups() {
    const outcomes = await Promise.allSettled([adminApi.getDatabaseBackups(), adminApi.getSiteBackups()])
    if (outcomes[0].status === 'fulfilled') databaseBackups.value = outcomes[0].value.backups || []
    if (outcomes[1].status === 'fulfilled') siteBackups.value = outcomes[1].value.backups || []
    const failed = outcomes.find(item => item.status === 'rejected' || item.value?.error)
    if (failed) showResult(failed.reason?.message || failed.value?.error || '读取备份清单失败', true)
}

async function createDatabaseBackup() {
    const result = await perform('database-backup', () => adminApi.createDatabaseBackup(), '数据库备份已创建')
    if (result) {
        databaseBackups.value = result.status?.backups || [result.backup, ...databaseBackups.value].filter(Boolean)
    }
}

async function createSiteBackup() {
    const result = await perform('site-backup', () => adminApi.createSiteBackup(), '整站备份包已创建')
    if (result) siteBackups.value = result.status?.backups || [result.backup, ...siteBackups.value].filter(Boolean)
}

function formatDate(value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString('zh-CN', { hour12: false })
}

async function signOut() {
    await lockAdmin()
}

onMounted(async () => {
    startAdminSessionTracking()
    const tasks = []
    if (canCast.value) tasks.push(loadCastDevices())
    if (canBackup.value) tasks.push(loadBackups())
    await Promise.all(tasks)
})
onUnmounted(stopAdminSessionTracking)
</script>

<template>
    <main class="customer-ops" :class="{ embedded }">
        <AdminWindowChrome v-if="embedded" @before-dashboard="router.push({ path: '/group', query: route.query })" @before-admin="router.push({ path: '/group', query: route.query })" />
        <header class="ops-header">
            <button class="ops-back" type="button" @click="router.push({ path: '/group', query: route.query })">← <span>返回大屏</span></button>
            <div class="ops-title"><small>ON-SITE OPERATIONS</small><h1>现场操作中心</h1><p>{{ adminSession.user?.displayName }} · {{ adminSession.user?.username }}</p></div>
            <button class="ops-signout" type="button" @click="signOut">退出登录</button>
        </header>

        <section v-if="canCast" class="ops-card cast-card">
            <div class="card-heading"><div><small>DISPLAY</small><h2>启动与投屏</h2><p>选择现场可用的屏幕，把当前大屏画面投送到目标设备。</p></div><span class="state-indicator" :class="{ active: castStatus?.casting }">{{ castStatus?.casting ? '正在投屏' : '现场可用' }}</span></div>
            <div class="cast-controls">
                <label>投屏目标
                    <select v-model="selectedDeviceId" :disabled="!castDevices.length || Boolean(busy)">
                        <option value="" disabled>{{ castDevices.length ? '请选择目标设备' : '尚未发现目标设备' }}</option>
                        <option v-for="device in castDevices" :key="device.id" :value="device.id">{{ device.name }} · {{ device.address }}</option>
                    </select>
                </label>
                <button type="button" class="secondary-action" :disabled="Boolean(busy)" @click="loadCastDevices(true)">{{ busy === 'cast-refresh' ? '搜索中…' : '搜索设备' }}</button>
                <button type="button" class="primary-action" :disabled="Boolean(busy) || !selectedDeviceId" @click="startCasting">{{ busy === 'cast-start' ? '正在连接…' : '开始投屏' }}</button>
                <button type="button" class="secondary-action" :disabled="Boolean(busy) || !castStatus?.casting" @click="stopCasting">停止投屏</button>
            </div>
            <p v-if="castStatus?.session" class="cast-current">当前目标：{{ castStatus.session.deviceName }}<span>· {{ castStatus.session.viewers || 0 }} 个观看端</span></p>
        </section>

        <section v-if="canBackup" class="ops-card backup-card">
            <div class="card-heading"><div><small>RECOVERY</small><h2>备份与下载</h2><p>现场账户可创建并下载备份；配置策略、删除或恢复数据由管理员负责。</p></div><button class="secondary-action" :disabled="Boolean(busy)" @click="loadBackups">刷新清单</button></div>
            <div class="backup-columns">
                <article class="backup-kind">
                    <div class="backup-kind-heading"><div><h3>数据库备份</h3><p>保存当前业务数据库快照</p></div><button class="primary-action" :disabled="Boolean(busy)" @click="createDatabaseBackup">{{ busy === 'database-backup' ? '创建中…' : '立即备份' }}</button></div>
                    <div v-if="databaseBackups.length" class="backup-list">
                        <div v-for="backup in databaseBackups" :key="backup.filename" class="backup-row"><span><strong>{{ backup.filename }}</strong><small>{{ formatDate(backup.createdAt || backup.created_at || backup.timestamp) }}</small></span><a :href="adminApi.databaseBackupDownloadUrl(backup.filename)">下载</a></div>
                    </div>
                    <p v-else class="empty-list">暂无可下载的数据库备份</p>
                </article>
                <article class="backup-kind">
                    <div class="backup-kind-heading"><div><h3>整站灾备包</h3><p>包含平台配置与现场资源</p></div><button class="primary-action" :disabled="Boolean(busy)" @click="createSiteBackup">{{ busy === 'site-backup' ? '打包中…' : '创建灾备包' }}</button></div>
                    <div v-if="siteBackups.length" class="backup-list">
                        <div v-for="backup in siteBackups" :key="backup.filename" class="backup-row"><span><strong>{{ backup.filename }}</strong><small>{{ formatDate(backup.createdAt || backup.created_at || backup.timestamp) }}</small></span><a :href="adminApi.siteBackupDownloadUrl(backup.filename)">下载</a></div>
                    </div>
                    <p v-else class="empty-list">暂无可下载的整站灾备包</p>
                </article>
            </div>
        </section>
        <p v-if="message" class="ops-message" :class="{ failed: failure }" role="status">{{ message }}</p>
        <footer class="ops-footer">权限由系统管理员分配 · 所有数据操作在本机安全会话中执行</footer>
    </main>
</template>

<style scoped>
.customer-ops{box-sizing:border-box;min-height:100vh;padding:48px clamp(22px,6vw,96px) 28px;background:#efefec;color:#292b26;font-family:Inter,"Segoe UI","Microsoft YaHei UI",sans-serif}.customer-ops.embedded{min-height:calc(100vh - 46px);padding-top:36px}.ops-header{display:grid;grid-template-columns:1fr minmax(280px,2fr) 1fr;align-items:start;gap:20px;max-width:1180px;margin:0 auto 34px;padding-bottom:24px;border-bottom:1px solid rgba(65,67,58,.15)}.ops-back,.ops-signout{justify-self:start;padding:9px 12px;border:1px solid rgba(70,72,64,.18);border-radius:7px;background:rgba(255,255,255,.42);color:#53554d;font:inherit;font-size:11px;cursor:pointer}.ops-signout{justify-self:end}.ops-title small,.card-heading small{color:#8a8b80;font-size:9px;letter-spacing:.18em}.ops-title h1{margin:7px 0 5px;font-size:25px;font-weight:560;letter-spacing:.025em}.ops-title p{margin:0;color:#83847a;font-size:11px}.ops-card{max-width:1100px;margin:0 auto 18px;padding:24px 26px;border:1px solid rgba(67,69,61,.13);border-radius:12px;background:rgba(250,250,248,.82);box-shadow:0 9px 26px rgba(44,46,39,.045)}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.card-heading h2{margin:7px 0;font-size:17px;font-weight:560}.card-heading p,.backup-kind-heading p{margin:0;color:#818279;font-size:11px;line-height:1.65}.state-indicator{padding:6px 9px;border:1px solid #d5d5ce;border-radius:99px;color:#77796e;font-size:10px;white-space:nowrap}.state-indicator.active{border-color:#9caf9f;color:#526c58;background:#ecf0eb}.cast-controls{display:grid;grid-template-columns:minmax(260px,1fr) auto auto auto;align-items:end;gap:9px;margin-top:24px}.cast-controls label{display:grid;gap:7px;color:#77796f;font-size:10px}.cast-controls select{box-sizing:border-box;height:39px;padding:0 11px;border:1px solid #d8d9d3;border-radius:6px;background:#fff;color:#383a34;font:inherit;font-size:11px}.primary-action,.secondary-action{height:39px;padding:0 14px;border:1px solid #44473f;border-radius:6px;background:#41443c;color:#f4f3ed;font:inherit;font-size:10px;cursor:pointer;white-space:nowrap}.secondary-action{border-color:#d0d1c9;background:rgba(255,255,255,.68);color:#55574f}.primary-action:disabled,.secondary-action:disabled{opacity:.5;cursor:wait}.cast-current{margin:15px 0 0;color:#71736a;font-size:10px}.cast-current span{margin-left:7px;color:#96978e}.backup-columns{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:20px}.backup-kind{min-width:0;padding:18px 17px;border:1px solid rgba(69,71,63,.12);border-radius:9px;background:rgba(245,245,241,.66)}.backup-kind-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.backup-kind-heading h3{margin:0 0 5px;font-size:13px;font-weight:560}.backup-kind-heading .primary-action{height:34px}.backup-list{margin-top:15px;border-top:1px solid rgba(69,71,63,.12)}.backup-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(69,71,63,.1)}.backup-row>span{display:grid;gap:4px;min-width:0}.backup-row strong{overflow:hidden;color:#4a4c44;font-size:10px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.backup-row small{color:#8b8c83;font-size:9px}.backup-row a{color:#657260;font-size:10px;text-decoration:none;white-space:nowrap}.backup-row a:hover{text-decoration:underline}.empty-list{margin:16px 0 2px;color:#95968e;font-size:10px}.ops-message{max-width:1100px;margin:15px auto 0;color:#61745e;font-size:11px}.ops-message.failed{color:#a44f44}.ops-footer{max-width:1100px;margin:24px auto 0;color:#96978d;font-size:9px;text-align:center}.ops-footer::before{content:"";display:block;width:34px;height:1px;margin:0 auto 14px;background:#b6b7ab}@media(max-width:760px){.customer-ops{padding:24px 15px}.ops-header{grid-template-columns:auto 1fr;gap:14px}.ops-title{grid-column:1/-1;grid-row:2}.ops-signout{grid-column:2;grid-row:1}.cast-controls{grid-template-columns:1fr 1fr}.cast-controls label{grid-column:1/-1}.backup-columns{grid-template-columns:1fr}.ops-card{padding:19px}}
</style>
