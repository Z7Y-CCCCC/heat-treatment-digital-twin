<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope, FACTORY_SCOPE_CHANGE_EVENT } from '../../../runtime/factoryScope.js'
const props = defineProps({ confirm: { type: Function, required: true } })
const data = ref(null), error = ref(''), actionError = ref(''), message = ref(''), busy = ref(false), detail = ref(false)
let timer, abort, disposed = false, loading = false, generation = 0
const source = computed(() => data.value?.configuredMode)
const devices = computed(() => data.value?.factories?.[0]?.devices || [])
const statusNames = { normal: '正常', abnormal: '异常', pending: '连接中', disabled: '未启用' }
const time = n => n ? new Date(n).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
const milliseconds = n => n == null ? '—' : `${Math.round(n)} ms`
async function refresh() {
  if (disposed || loading || document.visibilityState === 'hidden') return
  loading = true; const controller = new AbortController(); abort = controller
  const version = ++generation, scope = getFactoryScope(), timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const next = await adminApi.getCollectorStatus(controller.signal)
    if (disposed || version !== generation || scope !== getFactoryScope()) return
    if (next.error) throw Error(next.error)
    if (!next.counts || !next.process) throw Error('采集状态响应无效')
    data.value = next; error.value = ''
  } catch (cause) { if (!disposed && version === generation) error.value = cause.name === 'AbortError' ? '采集状态读取超时' : cause.message }
  finally { clearTimeout(timeout); if (version === generation) { abort = null; loading = false } }
}
async function changeSource(mode) {
  if (busy.value || !data.value || mode === source.value || !canAdminPage('settings.data', 'edit')) return
  const scope = getFactoryScope()
  if (!await props.confirm(mode === 'simulation' ? '切换为模拟演示？当前工厂将暂停读取 PLC。' : mode === 'external' ? '切换为外部接口？当前工厂将暂停读取 PLC。' : '切换为现场采集？将按后台已保存的设备与点位配置读取。')) return
  if (scope !== getFactoryScope() || !data.value) return
  busy.value = true; actionError.value = ''; message.value = ''
  try {
    const result = await adminApi.setCollectorMode({ mode, expectedMode: source.value })
    if (disposed || scope !== getFactoryScope()) return
    if (!result.success) throw Error(result.error || '数据来源切换失败')
    data.value.configuredMode = result.mode
    if (!result.runtimeApplied) message.value = '已保存，等待采集进程恢复同步'
  } catch (cause) { if (!disposed && scope === getFactoryScope()) actionError.value = cause.message }
  finally { busy.value = false; await refresh() }
}
const onVisible = () => { if (document.visibilityState !== 'hidden') refresh() }
const onScope = () => { generation++; abort?.abort(); loading = false; data.value = null; message.value = ''; error.value = ''; actionError.value = ''; refresh() }
onMounted(() => { refresh(); timer = setInterval(refresh, 2000); document.addEventListener('visibilitychange', onVisible); window.addEventListener(FACTORY_SCOPE_CHANGE_EVENT, onScope) })
onUnmounted(() => { disposed = true; generation++; abort?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener(FACTORY_SCOPE_CHANGE_EVENT, onScope) })
</script>
<template>
  <section class="collector-runtime" aria-label="采集进程健康状态" :data-state="error ? 'offline' : data?.state">
    <header><div class="runtime-heading"><span class="health-dot"></span><div><h3>{{ error ? '采集状态未连接' : data?.label || '正在检测采集进程…' }}</h3><p>{{ error || data?.reason || (data?.pluginInstalled===false ? '采集插件未安装' : data?.processRunning ? '已连接独立采集进程' : '自动检测后台采集状态') }}</p></div></div>
      <nav aria-label="采集数据来源"><button :aria-pressed="source==='external'" :disabled="busy||!data||!!error||!canAdminPage('settings.data','edit')" @click="changeSource('external')">外部接口</button><button :aria-pressed="source==='integrated_plc'" :disabled="busy||!data||!!error||data?.pluginInstalled===false||!canAdminPage('settings.data','edit')" @click="changeSource('integrated_plc')">现场采集</button><button :aria-pressed="source==='simulation'" :disabled="busy||!data||!!error||!canAdminPage('settings.data','edit')" @click="changeSource('simulation')">模拟演示</button></nav>
    </header>
    <div class="runtime-metrics"><div><small>正常设备</small><strong>{{error?'—':data?.counts.normal??'—'}}</strong></div><div><small>异常设备</small><strong :class="{warn:!error&&data?.counts.abnormal}">{{error?'—':data?.counts.abnormal??'—'}}</strong></div><div><small>帧传递耗时</small><strong>{{error?'—':milliseconds(data?.process.telemetryDelayMs)}}</strong></div><div><small>最近采样</small><strong>{{error?'—':time(data?.lastSampleAt)}}</strong></div></div>
    <footer><span>心跳 {{error?'—':milliseconds(data?.process.heartbeatAgeMs)}}<template v-if="data?.process.pid"> · PID {{data.process.pid}}</template><template v-if="data?.process.memoryRssBytes"> · {{Math.round(data.process.memoryRssBytes/1048576)}} MB</template><template v-if="data?.process.restartCount"> · 自动恢复 {{data.process.restartCount}} 次</template></span><button :aria-expanded="detail" @click="detail=!detail">{{detail?'收起设备状态':'设备状态'}}</button></footer>
    <div v-if="detail" class="runtime-devices"><table><thead><tr><th>设备</th><th>状态</th><th>读取耗时</th><th>最近读取</th><th>说明</th></tr></thead><tbody><tr v-for="d in devices" :key="d.deviceId"><td>{{d.name}}</td><td :class="d.state">{{error?'未连接':statusNames[d.state]}}</td><td>{{milliseconds(d.scanMs)}}</td><td>{{time(d.lastReadAt)}}</td><td>{{d.message}}</td></tr></tbody></table><p v-if="!devices.length">暂无启用的采集设备</p></div>
    <p v-if="busy" role="status" class="runtime-notice">正在切换数据来源…</p>
    <p v-if="actionError" role="alert" class="runtime-action-error">{{actionError}}</p>
    <p v-if="message" role="status" class="runtime-notice">{{message}}</p>
  </section>
</template>
<style scoped>
.collector-runtime{border:1px solid #e0e6ef;border-radius:12px;background:white;margin-bottom:18px;padding:20px 22px;color:#28364b}.collector-runtime header,.collector-runtime footer{display:flex;align-items:center;justify-content:space-between;gap:15px;flex-wrap:wrap}.runtime-heading{display:flex;gap:12px;align-items:center}.runtime-heading h3{margin:0;font-size:calc(17px * var(--admin-font-scale, 1))}.runtime-heading p{margin:7px 0 0;font-size:calc(12px * var(--admin-font-scale, 1));color:#8290a3}.health-dot{height:10px;width:10px;border-radius:50%;background:#92a3b6}.collector-runtime[data-state=healthy] .health-dot{background:#36ad86;box-shadow:0 0 0 5px #36ad8612}.collector-runtime[data-state=degraded] .health-dot,.collector-runtime[data-state=starting] .health-dot{background:#d9a449}.collector-runtime[data-state=offline] .health-dot{background:#d66b6b}.collector-runtime[data-state=simulation] .health-dot{background:#6c88d6}nav{display:flex;padding:4px;border:1px solid #e3e9f2;border-radius:24px;background:#f4f7fb}nav button{border:0;padding:8px 16px;border-radius:20px;background:transparent;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));color:#7c8da4;cursor:pointer}nav button[aria-pressed=true]{background:white;color:#2766c8;box-shadow:0 2px 7px #3e59831a}nav button:disabled{cursor:default}.runtime-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:22px 0 18px}.runtime-metrics>div{border-right:1px solid #ecf0f5;display:grid;gap:9px}.runtime-metrics>div:last-child{border:0}small{font-size:calc(11px * var(--admin-font-scale, 1));color:#8a97aa}strong{font-size:calc(22px * var(--admin-font-scale, 1));font-weight:600;font-variant-numeric:tabular-nums}.warn,.abnormal{color:#bf6856}footer{font-size:calc(11px * var(--admin-font-scale, 1));color:#93a0b1;border-top:1px solid #edf1f6;padding-top:12px}footer button{border:0;background:transparent;color:#4e77a5;font:inherit;cursor:pointer}.runtime-devices{max-height:235px;overflow:auto;margin-top:16px;border:1px solid #e6ebf2;border-radius:8px}table{border-collapse:collapse;width:100%;font-size:calc(12px * var(--admin-font-scale, 1));text-align:left}th{background:#f7f9fc;position:sticky;top:0;color:#8a97aa;font-weight:500}td,th{padding:10px;border-bottom:1px solid #edf1f6;white-space:nowrap}.normal{color:#329073}.runtime-devices p,.runtime-notice{padding:10px;font-size:calc(12px * var(--admin-font-scale, 1));color:#8a97aa}@media(max-width:850px){.runtime-metrics{grid-template-columns:1fr 1fr}.collector-runtime{padding:16px}}
.runtime-action-error{font-size:calc(12px * var(--admin-font-scale, 1));color:#b75c4f;margin:12px 0 0}</style>
