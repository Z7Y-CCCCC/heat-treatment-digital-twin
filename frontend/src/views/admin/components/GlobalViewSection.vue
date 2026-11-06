<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch } from '../../../runtime/adminSession.js'
import { GLOBAL_VIEWS, normalizeGlobalViews } from '../../../../../shared/viewNavigation.mjs'
const props = defineProps({ views: Array, selectedId: String, canEdit: Boolean })
const emit = defineEmits(['select', 'notice', 'policy'])
const config = ref(normalizeGlobalViews()), revision = ref(''), loading = ref(true), busy = ref(false), expanded = ref(true)
const count = computed(() => Object.values(config.value.enabled).filter(Boolean).length)
const names = computed(() => GLOBAL_VIEWS.map(view => ({ ...view, name: props.views?.find(item => item.id === view.id)?.name?.replace(/^\s*\d{2}\s+/, '') || view.name })))
let disposed = false
async function load() {
  try {
    const response = await adminFetch(API_BASE + '/view-navigation', { cache: 'no-store' }), data = await response.json()
    if (!response.ok) throw Error(data.error || '全局视角读取失败')
    if (!disposed && !busy.value) { config.value = normalizeGlobalViews(data.config); revision.value = data.revision; emit('policy', config.value) }
  } catch (error) { if (!disposed) emit('notice', error.message) }
  finally { if (!disposed) loading.value = false }
}
async function setEnabled(id, enabled) {
  if (busy.value || loading.value || !props.canEdit) return
  const previous = config.value, next = { ...previous, enabled: { ...previous.enabled } }
  for (const view of GLOBAL_VIEWS) if (!id || view.id === id) next.enabled[view.id] = enabled
  busy.value = true; config.value = next
  try {
    const response = await adminFetch(API_BASE + '/view-navigation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: next, revision: revision.value }) }), data = await response.json()
    if (!response.ok) throw Error(data.error || '全局视角保存失败')
    if (!disposed) { config.value = normalizeGlobalViews(data.config); revision.value = data.revision; emit('policy', config.value); emit('notice', '全局视角已更新', 'success') }
  } catch (error) { if (!disposed) { config.value = previous; emit('notice', error.message) } }
  finally { busy.value = false; if (!disposed) void load() }
}
onMounted(() => { void load(); window.addEventListener('focus', load); window.addEventListener('global-view-navigation-changed', load) })
onUnmounted(() => { disposed = true; window.removeEventListener('focus', load); window.removeEventListener('global-view-navigation-changed', load) })
</script>
<template>
  <section class="global-view-section" aria-label="全局视角" data-testid="global-view-section">
    <header><button type="button" class="section-heading" :aria-expanded="expanded" @click="expanded=!expanded"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10h14"/></svg><span><strong>全局视角</strong><small>所有工厂共用</small></span><em>{{ count }}/7</em></button>
      <button type="button" class="view-switch master" role="switch" aria-label="启用全部全局视角" :aria-checked="count>0" :class="{on:count>0}" :disabled="!canEdit||loading||busy" @click="setEnabled('',count===0)"><span>{{ count>0?'启用':'关闭' }}</span><i/></button>
    </header>
    <div v-if="expanded" class="global-view-rows">
      <div v-for="view in names" :key="view.id" class="global-view-row" :class="{selected:selectedId===view.id,off:!config.enabled[view.id]}" :data-global-view-id="view.id">
        <button type="button" class="global-view-name" :title="view.name" @click="emit('select',view.id)"><span class="surface-dot" :class="{site:view.id.startsWith('site_')}"/><span>{{ view.name }}</span></button>
        <button type="button" class="view-switch" role="switch" :aria-label="`启用${view.name}`" :aria-checked="config.enabled[view.id]" :class="{on:config.enabled[view.id]}" :disabled="!canEdit||loading||busy" @click="setEnabled(view.id,!config.enabled[view.id])"><i/></button>
      </div>
    </div>
  </section>
</template>
<style scoped>
.global-view-section{margin:0 0 12px;border:1px solid #e1e7ef;border-radius:10px;background:linear-gradient(135deg,#f5f8ff,#fff);overflow:hidden}.global-view-section header{display:flex;align-items:center;gap:6px;padding:10px}.section-heading{display:flex;align-items:center;gap:7px;min-width:0;flex:1;border:0;background:none;padding:0;text-align:left;color:#34455e;cursor:pointer}.section-heading svg{width:19px;fill:none;stroke:#6488c9;stroke-width:1.3;flex:none}.section-heading span{display:grid;gap:2px}.section-heading strong{font-size:13px}.section-heading small{font-size:10px;color:#8795a8}.section-heading em{margin-left:auto;font-size:10px;color:#8394aa;font-style:normal}.global-view-rows{padding:0 5px 6px}.global-view-row{display:flex;align-items:center;gap:5px;min-height:34px;border-radius:6px;padding:0 5px}.global-view-row.selected{background:#e9f0ff}.global-view-name{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:8px 0;border:0;background:none;text-align:left;color:#40536d;font:inherit;font-size:12px;cursor:pointer}.global-view-name>span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.off .global-view-name{color:#98a3b2}.surface-dot{width:6px;height:6px;border-radius:50%;background:#7999ce;flex:none}.surface-dot.site{border-radius:2px;background:#aa91c6}.off .surface-dot{background:#c2cad5}.view-switch{display:flex;align-items:center;justify-content:flex-start;box-sizing:border-box;flex:none;width:29px;height:18px;padding:2px;border:1px solid #d5dce6;border-radius:99px;background:#e5e9ef;cursor:pointer}.view-switch i{display:block;width:12px;height:12px;background:white;border-radius:50%;box-shadow:0 1px 3px #33415525;transition:transform .15s}.view-switch.on{background:#d7f2e5;border-color:#a9dfc6}.view-switch.on i{transform:translateX(10px)}.view-switch.master{width:55px;height:22px;justify-content:space-between;padding:2px 3px 2px 7px;font-size:10px;color:#8490a1}.master.on{color:#238263}.master i{width:14px;height:14px}.master.on i{transform:none}.view-switch:disabled{cursor:default;opacity:.6}.view-switch:focus-visible,.section-heading:focus-visible,.global-view-name:focus-visible{outline:2px solid #81a5e9;outline-offset:1px}@media(prefers-reduced-motion:reduce){.view-switch i{transition:none}}
</style>
