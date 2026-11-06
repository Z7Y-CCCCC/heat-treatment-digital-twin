<script setup>
import { computed, ref } from 'vue'
const props = defineProps({ catalog: Object, extended: Object, retracted: Object, disabled: Boolean, busy: Boolean, error: String })
const emit = defineEmits(['select', 'refresh', 'clear'])
const query = ref('')
const options = computed(() => (props.catalog?.items || []).filter(item => item.type === 'boolean' && item.motionReady === true && item.enabled !== false && item.sourceReady !== false))
const filtered = computed(() => options.value.filter(item => !query.value.trim() || [item.label, props.catalog?.tables?.find(table => table.id === item.tableId)?.name].some(value => String(value || '').toLowerCase().includes(query.value.trim().toLowerCase()))))
const sides = [{ id: 'extended', label: '推料到位', hint: '确认伸出端 · 动作 100%' }, { id: 'retracted', label: '退回到位', hint: '确认退回端 · 动作 0%' }]
const selected = side => options.value.find(item => item.id === props[side]?.dataItemId)
function choose(side, id) { if (props.disabled || props.busy) return; const item = options.value.find(item => item.id === id); if (item) emit('select', side, item) }
const optionLabel = item => `${item.label} · ${props.catalog?.tables?.find(table => table.id === item.tableId)?.name || '数据中心'}`
</script>
<template>
  <section class="motion-endpoint-picker" aria-label="两个到位反馈">
    <header><div><strong>两个到位反馈</strong><small>选择现有开关量，无需新增点位</small></div><button type="button" :disabled="busy" aria-label="刷新到位数据目录" @click="emit('refresh')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></header>
    <input v-model="query" type="search" placeholder="搜索点位名称或数据表" aria-label="搜索到位反馈数据" :disabled="busy" />
    <label v-for="side in sides" :key="side.id"><span><strong>{{ side.label }}</strong><small>{{ side.hint }}</small></span><select :value="props[side.id]?.dataItemId || ''" :aria-label="`${side.label}数据项`" :disabled="disabled || busy" @change="choose(side.id, $event.target.value)"><option value="">选择本设备已整理的开关量</option><option v-if="props[side.id]?.dataItemId && !selected(side.id)" :value="props[side.id].dataItemId" disabled>原反馈不可用，请重新选择</option><option v-if="selected(side.id) && !filtered.some(item => item.id === selected(side.id).id)" :value="selected(side.id).id">已绑定 · {{ optionLabel(selected(side.id)) }}</option><option v-for="item in filtered" :key="item.id" :value="item.id">{{ optionLabel(item) }}</option></select></label>
    <p class="endpoint-rule">单端到位才确认端点。两端均未到位时等待，两个同时到位时提示冲突；不根据动画时间认定成功。</p>
    <button v-if="extended?.dataItemId || retracted?.dataItemId" type="button" class="clear-endpoints" :disabled="disabled || busy" aria-label="解除两个到位反馈" @click="emit('clear')">解除两个反馈<span>同时停用此动作</span></button>
    <p v-if="error" class="endpoint-error" role="alert">{{ error }}</p><p v-else-if="!busy && !options.length" class="endpoint-rule">当前设备没有可用开关量，请先在数据中心整理已有点位或数据表字段。</p>
  </section>
</template>
<style scoped>
.motion-endpoint-picker{display:grid;gap:12px;padding:13px;border:1px solid #cfdef2;border-radius:9px;background:linear-gradient(130deg,#f1f7ff,#fff);color:#476488}.motion-endpoint-picker header{display:flex;align-items:center;justify-content:space-between;gap:8px}.motion-endpoint-picker header>div{display:grid;gap:5px}.motion-endpoint-picker strong{font-size:12px;font-weight:600}.motion-endpoint-picker small{font-size:10px;color:#8b9db5}.motion-endpoint-picker header button{width:24px;height:24px;padding:4px;border:0;background:none;color:#7892b6;cursor:pointer}.motion-endpoint-picker svg{width:15px;height:15px;stroke:currentColor;stroke-width:1.6;fill:none}.motion-endpoint-picker label{display:grid;gap:7px}.motion-endpoint-picker label>span{display:flex;align-items:center;justify-content:space-between;gap:7px}.motion-endpoint-picker input,.motion-endpoint-picker select{box-sizing:border-box;width:100%;min-width:0;height:35px;padding:7px 8px;border:1px solid #d2dfef;border-radius:6px;background:white;color:#425f82;font:inherit;font-size:12px}.motion-endpoint-picker input:focus-visible,.motion-endpoint-picker select:focus-visible{outline:2px solid #acc9f2;outline-offset:1px}.endpoint-rule{margin:0;color:#7b8fa8;font-size:11px;line-height:1.7}.clear-endpoints{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border:0;background:transparent;color:#6c82a1;font:inherit;font-size:11px;cursor:pointer}.clear-endpoints span{color:#9aa9bc;font-size:10px}.endpoint-error{margin:0;color:#b26d36;font-size:11px;line-height:1.6}
</style>
