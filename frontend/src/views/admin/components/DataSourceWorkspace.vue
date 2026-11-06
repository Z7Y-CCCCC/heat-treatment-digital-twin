<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { canAdminPage } from '../../../runtime/adminSession.js'
import DataSourceConnectionForm from './DataSourceConnectionForm.vue'
import DataSourcePreview from './DataSourcePreview.vue'
import DataSetWorkspace from './DataSetWorkspace.vue'
import { DATA_SOURCE_CATALOG, SOURCE_GROUPS, capabilityLabel, filterSources, sourceCatalogEntry, sourceEndpoint, sourceStatus } from '../utils/dataSourceCatalog.js'
const props = defineProps({
    connections: { type: Array, default: () => [] }, draft: { type: Object, required: true },
    health: { type: Object, default: () => ({}) }, busy: Boolean, dirty: Boolean,
    message: { type: String, default: '' }, permissionPage: { type: String, default: 'settings.database' },
    confirm: { type: Function, required: true }, alert: { type: Function, required: true },
    mode: { type: String, default: 'all' }
})
const emit = defineEmits(['create', 'edit', 'test', 'save', 'remove', 'open-plc'])
const search = ref(''), group = ref('all'), page = ref(1), pageSize = ref(8), creating = ref(false), section = ref('connection')
const pickerOpen = ref(false), pickerSearch = ref(''), pickerGroup = ref('all'), picker = ref(null), pickerInput = ref(null)
const uploadBusy = ref(false), working = computed(() => props.busy || uploadBusy.value)
let returnFocus
const canEdit = computed(() => canAdminPage(props.permissionPage, 'edit'))
const canDelete = computed(() => canAdminPage(props.permissionPage, 'delete'))
const workspaceTab = ref(props.mode === 'datasets' ? 'datasets' : 'connections'), visitedDataSets = ref(props.mode === 'datasets'), datasetEditor = ref(null)
const isBusy = computed(() => working.value || workspaceTab.value === 'datasets' && datasetEditor.value?.isBusy)
const isDirty = computed(() => props.dirty || workspaceTab.value === 'datasets' && datasetEditor.value?.isDirty)
function switchWorkspace(key) { workspaceTab.value = key; if (key === 'datasets') visitedDataSets.value = true }
watch(() => props.mode, mode => { if (mode !== 'all') switchWorkspace(mode === 'datasets' ? 'datasets' : 'connections') })
async function canLeave() {
    if (workspaceTab.value === 'datasets') return datasetEditor.value?.canLeave?.() ?? true
    if (!await allowDiscard()) return false
    if (props.dirty) { creating.value = false; emit('create'); section.value = 'connection' }
    return true
}
async function savePending() { if (workspaceTab.value === 'datasets') await datasetEditor.value?.savePending?.() }
function discardPending() { if (workspaceTab.value === 'datasets') datasetEditor.value?.discardPending?.() }
defineExpose({ canLeave, isBusy, isDirty, savePending, discardPending })
const sources = computed(() => props.connections.filter(item => !item.primary))
const filtered = computed(() => filterSources(props.connections, search.value, group.value))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const rows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const active = computed(() => Boolean(props.draft.id || creating.value))
const creatingType = ref('')
const selectedType = computed(() => creating.value && !props.draft.baseUrl
    ? DATA_SOURCE_CATALOG.find(item => item.key === creatingType.value) || sourceCatalogEntry(props.draft)
    : sourceCatalogEntry(props.draft))
const saved = computed(() => sources.value.find(item => item.id === props.draft.id))
const catalog = computed(() => DATA_SOURCE_CATALOG.filter(item => (pickerGroup.value === 'all' || item.group === pickerGroup.value)
    && `${item.name} ${item.description}`.toLowerCase().includes(pickerSearch.value.trim().toLowerCase())))
const sections = [{ key: 'connection', label: '连接配置' }, { key: 'authentication', label: '认证' }, { key: 'advanced', label: '高级' }, { key: 'preview', label: '数据预览' }]
watch([search, group, pageSize], () => { page.value = 1 })
watch(pages, count => { page.value = Math.min(page.value, count) })
watch(() => props.draft.id, (id, previous) => { if (!id && previous) creating.value = false }, { flush: 'sync' })
async function allowDiscard() {
    if (working.value) return false
    return !props.dirty || await props.confirm('当前数据源有未保存的修改，是否放弃？', { title: '未保存的数据源', confirmText: '放弃修改', cancelText: '继续编辑', type: 'warning' })
}
async function choose(connection) {
    if (connection.id === props.draft.id || !await allowDiscard()) return
    creating.value = false; section.value = 'connection'; emit('edit', connection)
}
async function create(entry) {
    if (working.value) return
    if (entry.status === 'planned') return props.alert(`${entry.name} 暂未接入。`, { title: entry.name + ' · 待接入', type: 'info' })
    if (entry.status === 'device') {
        if (!canAdminPage('devices')) return props.alert('当前账号没有设备管理页面权限。', { title: '无页面权限' })
        if (await allowDiscard()) { closePicker(); emit('open-plc') }
        return
    }
    if (!canEdit.value || !await allowDiscard()) return
    emit('create', { ...entry.draft }); creatingType.value = entry.key; creating.value = true; section.value = 'connection'; closePicker()
}
async function closeEditor() {
    if (!await allowDiscard()) return
    creating.value = false; emit('create'); section.value = 'connection'
}
async function openPicker() {
    if (!canEdit.value || working.value) return
    returnFocus = document.activeElement; pickerSearch.value = ''; pickerGroup.value = 'all'; pickerOpen.value = true
    await nextTick(); pickerInput.value?.focus()
}
function closePicker() {
    pickerOpen.value = false
    nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
}
function pickerKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); return }
    if (event.key !== 'Tab') return
    const controls = [...picker.value.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]')].filter(el => el.getClientRects().length)
    if (!controls.length) return
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
}
async function tabKeys(event, index) {
    const next = { ArrowRight: (index + 1) % sections.length, ArrowLeft: (index + sections.length - 1) % sections.length, Home: 0, End: sections.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault(); section.value = sections[next].key
    await nextTick(); document.getElementById('source-editor-tab-' + section.value)?.focus()
}
</script>

<template>
    <div class="source-workspace">
        <header class="workspace-heading">
            <nav v-if="mode==='all'" class="workspace-tabs" aria-label="数据接入分类"><button type="button" :class="{active:workspaceTab==='connections'}" :aria-pressed="workspaceTab==='connections'" @click="switchWorkspace('connections')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 14h3M14 14h3"/></svg>连接<span>{{sources.length}}</span></button><button type="button" :class="{active:workspaceTab==='datasets'}" :aria-pressed="workspaceTab==='datasets'" @click="switchWorkspace('datasets')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16M10 10v10"/></svg>数据表</button></nav>
            <div v-else class="standalone-heading"><strong>{{mode==='datasets'?'外部数据表':'外部数据源'}}</strong><small>{{mode==='datasets'?'整理中文字段、单位与对象映射，设计器直接选用':'先连接数据，再将需要的字段整理成数据表'}}</small></div>
            <button v-if="workspaceTab==='connections'" type="button" class="btn btn-primary btn-sm" :disabled="!canEdit || working" @click="openPicker">＋ 新建数据源</button>
            <button v-else type="button" class="btn btn-primary btn-sm" :disabled="!canEdit || working" @click="datasetEditor?.create()">＋ 新建数据表</button>
        </header>
        <DataSetWorkspace ref="datasetEditor" v-if="visitedDataSets" v-show="workspaceTab==='datasets'" :connections="connections" :permission-page="permissionPage" :confirm="confirm" />
        <div v-show="workspaceTab==='connections'">
        <div v-if="sources.length || active" class="source-workbench">
            <aside class="source-sidebar" aria-label="已保存数据源">
                <div class="source-list-tools"><input v-model="search" type="search" class="input" aria-label="搜索数据源" placeholder="名称 / 地址" /><select v-model="group" class="input" aria-label="筛选数据源类型"><option v-for="item in SOURCE_GROUPS" :key="item.key" :value="item.key">{{ item.label }}</option></select></div>
                <div class="source-list">
                    <button v-for="connection in rows" :key="connection.id" type="button" class="source-row" :class="{ selected: draft.id === connection.id }" :aria-pressed="draft.id === connection.id" :disabled="working" @click="choose(connection)">
                        <img class="source-logo" :src="sourceCatalogEntry(connection).image" :alt="sourceCatalogEntry(connection).name" />
                        <span class="source-row-copy"><strong>{{ connection.name }}</strong><small :title="sourceEndpoint(connection)">{{ sourceEndpoint(connection) }}</small><em class="source-status" :class="sourceStatus(connection).key">{{ sourceStatus(connection).label }}</em></span>
                    </button>
                    <p v-if="!rows.length" class="source-empty">{{ sources.length ? '没有匹配的数据源' : '暂无已保存连接' }}</p>
                </div>
                <div class="source-pager"><span>{{ filtered.length }} 个</span><select v-model.number="pageSize" aria-label="每页数据源数量"><option :value="8">8 / 页</option><option :value="16">16 / 页</option><option :value="32">32 / 页</option></select><button type="button" aria-label="上一页数据源" :disabled="page <= 1" @click="page--">‹</button><span>{{ page }}/{{ pages }}</span><button type="button" aria-label="下一页数据源" :disabled="page >= pages" @click="page++">›</button></div>
            </aside>
            <section v-if="active" class="source-detail" aria-label="数据源配置">
                <header class="source-detail-heading"><span class="source-icon" :style="{ '--source-color': selectedType.color }">{{ selectedType.badge }}</span><div><h4>{{ draft.name || '新建数据源' }}</h4><small>{{ selectedType.name }} <span v-if="dirty" class="draft-indicator">· 未保存</span></small></div><button type="button" class="close-editor" :disabled="working" aria-label="关闭数据源编辑" @click="closeEditor">×</button></header>
                <nav class="source-editor-tabs" role="tablist" aria-label="数据源配置分类"><button v-for="(tab, index) in sections" :id="'source-editor-tab-' + tab.key" :key="tab.key" type="button" role="tab" :aria-selected="section === tab.key" :aria-controls="'source-editor-panel-' + tab.key" :tabindex="section === tab.key ? 0 : -1" @click="section = tab.key" @keydown="tabKeys($event, index)">{{ tab.label }}</button></nav>
                <div :id="'source-editor-panel-' + section" role="tabpanel" :aria-labelledby="'source-editor-tab-' + section" class="source-detail-body">
                    <DataSourceConnectionForm v-show="section !== 'preview'" :draft="draft" :section="section" :busy="busy" :permission-page="permissionPage" @upload-state="uploadBusy = $event" />
                    <template v-if="section === 'preview'"><DataSourcePreview v-if="saved && !dirty" :key="saved.id + ':' + saved.configRevision" :connection="saved" /><p v-else class="source-empty">请先保存当前连接，再预览业务数据。</p></template>
                </div>
                <footer class="source-detail-footer">
                    <div v-if="health.status" class="source-health" :class="health.status"><strong><i></i>{{ ({ healthy: '检查通过', auth_failed: '认证失败', network_error: '连接失败', timeout: '检查超时', config_error: '配置有误', http_error: '接口异常', check_failed: '检查失败' })[health.status] || '未检查' }}</strong><span v-if="Number.isFinite(health.responseTimeMs)">{{ health.responseTimeMs }}ms</span><span v-if="health.httpStatus">HTTP {{ health.httpStatus }}</span><span v-if="health.checkedAt">{{ new Date(health.checkedAt).toLocaleTimeString('zh-CN',{hour12:false}) }}</span><small v-if="health.status!=='healthy'">{{ health.message }}</small></div>
                    <p v-if="message" role="status" class="source-message">{{ message }}</p>
                    <div class="source-actions"><button type="button" class="btn btn-sm" :disabled="working || !canEdit" @click="emit('test')">{{ working ? '处理中…' : '测试连接' }}</button><button type="button" class="btn btn-primary btn-sm" :disabled="working || !canEdit" @click="emit('save')">保存数据源</button><button v-if="draft.id" type="button" class="btn btn-danger btn-sm delete-source" :disabled="working || !canDelete" @click="emit('remove', { ...draft })">删除</button></div>
                </footer>
            </section>
            <section v-else class="source-empty source-detail">选择左侧连接查看配置，或新建数据源。</section>
        </div>
        <div v-else class="source-start">
            <div class="picker-tools"><input v-model="pickerSearch" class="input" type="search" aria-label="搜索接入类型" placeholder="搜索类型" /><select v-model="pickerGroup" class="input" aria-label="接入类型分类"><option v-for="item in SOURCE_GROUPS" :key="item.key" :value="item.key">{{ item.label }}</option></select></div>
            <div class="source-catalog"><button v-for="entry in catalog" :key="entry.key" type="button" class="source-type-card" :title="entry.description" :disabled="working || entry.status === 'ready' && !canEdit" @click="create(entry)"><img :src="entry.image" :alt="entry.name" loading="lazy" /><span class="type-card-caption"><strong>{{ entry.name }}</strong><em :class="entry.status">{{ capabilityLabel(entry) }}</em></span></button></div>
        </div>
        <Teleport to="body">
            <div v-if="pickerOpen" class="source-picker-backdrop" @keydown="pickerKeys">
                <section ref="picker" class="source-picker" role="dialog" aria-modal="true" aria-labelledby="source-picker-title">
                    <header><h3 id="source-picker-title">新建数据源</h3><button type="button" class="close-editor" aria-label="关闭数据源类型选择" @click="closePicker">×</button></header>
                    <div class="picker-tools"><input ref="pickerInput" v-model="pickerSearch" class="input" type="search" aria-label="搜索接入类型" placeholder="搜索类型" /><select v-model="pickerGroup" class="input" aria-label="接入类型分类"><option v-for="item in SOURCE_GROUPS" :key="item.key" :value="item.key">{{ item.label }}</option></select></div>
                    <div class="source-catalog"><button v-for="entry in catalog" :key="entry.key" type="button" class="source-type-card" :title="entry.description" :disabled="working || entry.status === 'ready' && !canEdit" @click="create(entry)"><img :src="entry.image" :alt="entry.name" loading="lazy" /><span class="type-card-caption"><strong>{{ entry.name }}</strong><em :class="entry.status">{{ capabilityLabel(entry) }}</em></span></button></div>
                    <p v-if="!catalog.length" class="source-empty">没有匹配的接入类型</p>
                </section>
            </div>
        </Teleport>
        </div>
    </div>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
* { box-sizing: border-box; }
.source-workspace { color:#344054; }
.standalone-heading { display:grid; gap:6px; }.standalone-heading strong { color:#61748e; font-size:calc(14px * var(--admin-font-scale,1)); font-weight:550; }.standalone-heading small { color:#9aa7ba; font-size:calc(11px * var(--admin-font-scale,1)); }
.workspace-tabs { display:flex; gap:4px; padding:4px; border:1px solid #e9edf2; border-radius:8px; background:#f4f6f9; }
.workspace-tabs button { display:flex; gap:8px; align-items:center; padding:7px 14px; border:0; border-radius:5px; background:transparent; color:#8490a2; font:inherit; font-size:calc(12px * var(--admin-font-scale, 1)); cursor:pointer; }
.workspace-tabs button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; }
.workspace-tabs button span { color:#9da9bc; font-size:calc(10px * var(--admin-font-scale, 1)); }
.workspace-tabs button.active { background:#fff; color:#3566c5; box-shadow:0 1px 3px #182b4b0c; font-weight:600; }
.btn { font-weight:500; box-shadow:0 1px 2px #10182805; background:#fff; color:#52627a; border-color:#dce2ea; border-radius:6px; padding:8px 13px; white-space:nowrap; }
.btn:not(:disabled):hover { transform:none; background:#f8faff; border-color:#b4c9ef; box-shadow:none; color:#2563eb; }
.btn-primary { background:#3269df; border-color:#3269df; color:#fff; }
.btn-primary:not(:disabled):hover { background:#275bcb; color:#fff; border-color:#275bcb; }
.btn-danger { color:#9a7379; border-color:#e7e9ed; }
.input { border-color:#dce1e8; background:#fff; border-radius:6px; color:#344054; box-shadow:0 1px 2px #10182803; min-height:36px; }
.input:focus { border-color:#91b2f4; box-shadow:0 0 0 2px #2563eb0d; }
.input::placeholder { color:#a8b0bf; }
.workspace-heading, .source-detail-heading, .source-picker header { display: flex; align-items: center; gap: 12px; }
.workspace-heading { justify-content: space-between; margin-bottom: 18px; }
h3, h4, p { margin: 0; } h3 { font-size: calc(15px * var(--admin-font-scale, 1)); color: #22344d; } h4 { font-size: calc(15px * var(--admin-font-scale, 1)); color: #253248; font-weight:600; overflow-wrap: anywhere; }
.workspace-heading p, .source-picker header p { margin-top: 6px; color: #8490a1; font-size: calc(12px * var(--admin-font-scale, 1)); }
.source-workbench { display: grid; grid-template-columns: 224px minmax(0, 1fr); border: 1px solid #e4e7ec; border-radius: 10px; overflow: hidden; }
.source-sidebar { padding: 16px 12px; background: #fafbfc; min-width: 0; border-right: 1px solid #e2e8f0; }
.source-list-tools { display: grid; gap: 8px; }
.input { min-width: 0; width: 100%; font: inherit; font-size: calc(12px * var(--admin-font-scale, 1)); }
.source-list { max-height: 375px; overflow: auto; margin: 12px -4px 0; padding: 0 4px; }
.source-row { display: flex; min-height:72px; width: 100%; gap: 10px; align-items: center; background: transparent; border: 1px solid transparent; border-radius: 9px; padding: 11px 8px; cursor: pointer; text-align: left; margin-bottom: 4px; }
.source-row.selected { border-color: transparent; background: #edf3ff; }
.source-row:hover { background: #edf2f9; }
.source-row-copy { display: grid; gap: 5px; min-width: 0; }
.source-row-copy strong, .source-row-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-row-copy strong { font-size: calc(13px * var(--admin-font-scale, 1)); color: #344054; } .source-row-copy small { font-size: calc(10px * var(--admin-font-scale, 1)); color: #8490a1; }
.source-icon { --source-color: #2672d9; background: color-mix(in srgb, var(--source-color) 12%, white); color: var(--source-color); border: 1px solid color-mix(in srgb, var(--source-color) 22%, white); width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; flex: 0 0 auto; font-size: calc(11px * var(--admin-font-scale, 1)); font-weight: 700; }
.source-logo { width: 40px; height: 30px; object-fit: cover; border-radius: 5px; flex: 0 0 auto; }
.source-status { font-size: calc(10px * var(--admin-font-scale, 1)); font-style: normal; color: #9a641b; }.source-status.healthy { color: #17835a; }.source-status.unknown, .source-status.disabled { color: #8490a1; }
.source-pager { display: flex; gap: 7px; align-items: center; justify-content: space-between; margin-top: 12px; color: #78869a; font-size: calc(10px * var(--admin-font-scale, 1)); }
.source-pager button, .source-pager select { background: #fff; border: 1px solid #dce3ed; border-radius: 5px; padding: 4px; color: #536176; font: inherit; }
.source-detail { min-width: 0; padding: 20px 24px 0; background: #fff; }
.source-detail-heading { margin-bottom: 12px; position: relative; padding-right: 25px; }
.source-detail-heading small { display: block; margin-top: 5px; font-size: calc(11px * var(--admin-font-scale, 1)); color: #8490a1; }
.draft-indicator { color: #c48217; }
.close-editor { position: absolute; top: -8px; right: -8px; width: 28px; height: 28px; padding: 0; border: 0; background: transparent; color: #7d8ba0; cursor: pointer; font-size: calc(19px * var(--admin-font-scale, 1)); }
.source-editor-tabs { display: flex; gap: 24px; border-bottom: 1px solid #eef0f4; overflow: auto; }
.source-editor-tabs button { padding: 11px 0 12px; flex: 0 0 auto; border: 0; border-bottom: 2px solid transparent; background: transparent; font-size: calc(12px * var(--admin-font-scale, 1)); color: #7b899c; cursor: pointer; }
.source-editor-tabs button[aria-selected=true] { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
.source-detail-body { height:clamp(240px,calc(100vh - 690px),320px); overflow:auto; padding:0 1px; }
.source-detail-footer { border-top:1px solid #eef0f4; padding:14px 0; }
.source-actions { display: flex; gap: 9px; align-items: center; }.delete-source { margin-left: auto; }
.source-message { color: #64748b; font-size: calc(12px * var(--admin-font-scale, 1)); margin-bottom: 10px; line-height: 1.5; overflow-wrap: anywhere; }
.source-health { display:flex; flex-wrap:wrap; align-items:center; gap:7px 14px; margin-bottom:12px; font-size:calc(11px * var(--admin-font-scale, 1)); color:#b07a42; }.source-health strong { display:flex; align-items:center; gap:6px; font-size:calc(11px * var(--admin-font-scale, 1)); font-weight:500; }.source-health strong i { width:5px; height:5px; background:currentColor; border-radius:50%; }.source-health>span { color:#98a2b3; }
.source-health small { flex-basis: 100%; line-height: 1.4; overflow-wrap: anywhere; }.source-health.healthy { color:#458e72; }
.source-empty { padding: 24px 8px; text-align: center; color: #8490a1; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.6; }
.source-catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; max-height: min(470px, 50vh); overflow: auto; padding: 3px; }
.source-type-card { display:flex; flex-direction:row; align-items:center; min-height:76px; gap:12px; padding:14px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; text-align: left; cursor: pointer; overflow: hidden; }
.source-type-card > img { display:block; width:64px; height:40px; border-radius:5px; flex:none; object-fit:contain; }
.type-card-caption { display:grid; gap:8px; min-width:0; padding:0; }
.type-card-caption strong { font-size:calc(13px * var(--admin-font-scale, 1)); font-weight:500; color:#475467; }.type-card-caption em { font-size:calc(10px * var(--admin-font-scale, 1)); color:#a4adba; font-style: normal; }.type-card-caption em.ready { color: #19865a; }.type-card-caption em.device { color: #3776b9; }
.source-type-card:not(:disabled):hover { border-color: #8cb6f6; background: #f7faff; box-shadow: 0 5px 15px #3467a90a; }
button:disabled { opacity: .55; cursor: not-allowed; } button:focus-visible { outline: 2px solid #8bb8f8; outline-offset: 2px; }
.source-footnote { color: #93a0b1; font-size: calc(11px * var(--admin-font-scale, 1)); line-height: 1.7; margin-top: 16px; }
.source-picker-backdrop { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; background: #17233870; padding: 20px; }
.source-picker { width: min(1000px, 100%); max-height: 85vh; overflow: auto; background: #fff; border-radius: 14px; padding: 24px; box-shadow: 0 20px 70px #0c1c4540; }
.source-picker header { position: relative; margin-bottom: 20px; }.source-picker header .close-editor { top:-12px; right:-12px; }
.picker-tools { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 12px; margin-bottom: 18px; }
@media(max-width: 1100px) { .source-workbench { grid-template-columns: 200px minmax(0, 1fr); }.source-detail { padding: 14px; }.source-actions .btn { padding: 7px 9px; } }
@media(max-width: 760px) { .source-workbench { grid-template-columns: minmax(0, 1fr); }.source-sidebar { border-right: 0; border-bottom: 1px solid #e2e8f0; }.source-list { max-height: 180px; }.source-catalog { grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); }.source-picker { padding: 20px; } }
</style>
