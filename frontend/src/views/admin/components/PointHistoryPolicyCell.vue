<script setup>
import { ref, watch } from 'vue'
const props = defineProps({ policy: Object, unavailableLabel: { type: String, default: '先保存点位' }, disabled: Boolean, busy: Boolean, loading: Boolean, savePolicy: { type: Function, required: true } })
const mode = ref('recent'), days = ref(30)
function reset() { mode.value = props.policy?.mode ?? 'recent'; days.value = props.policy?.days ?? 30 }
watch(() => props.policy, reset, { immediate: true, deep: true })
async function save() { try { await props.savePolicy({ mode: mode.value, days: days.value }) } finally { reset() } }
</script>
<template>
  <div v-if="policy" class="point-history-cell" :aria-busy="busy">
    <select v-model="mode" aria-label="点位保存策略" :disabled="disabled || busy || loading" @change="save">
      <option value="recent">仅近期趋势</option><option value="off">不记录</option><option value="finite">按天保留</option><option value="permanent">永久保留</option>
    </select>
    <label v-if="mode === 'finite'" class="retention-days"><input v-model.number="days" type="number" min="1" max="36500" step="1" aria-label="点位保留天数" :disabled="disabled || busy || loading" @change="save" />天</label>
  </div>
  <span v-else class="unavailable">{{ loading ? '读取中…' : unavailableLabel }}</span>
</template>
<style scoped>
.point-history-cell{display:flex;align-items:center;gap:5px;min-height:32px}.point-history-cell select{box-sizing:border-box;min-width:0;width:calc(112px * var(--point-column-scale,1));height:calc(32px * var(--point-column-scale,1));padding:3px 5px;border:1px solid #cbd5e3;border-radius:6px;background:white;color:#24364b;font:inherit;font-size:calc(13px * var(--point-column-scale,1))}.retention-days{display:flex;align-items:center;gap:3px;color:#60748a;font-size:calc(13px * var(--point-column-scale,1))}.retention-days input{box-sizing:border-box;width:calc(65px * var(--point-column-scale,1));min-width:0;height:calc(32px * var(--point-column-scale,1));padding:3px;border:1px solid #cbd5e3;border-radius:6px;font:inherit}.point-history-cell :disabled{background:#f3f5f8;color:#7c8a9a;cursor:not-allowed}.unavailable{font-size:11px;color:#7a879b}
</style>
