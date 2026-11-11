<script setup>
import { computed } from 'vue'
import { DASHBOARD_CHARTS } from '../../../../../shared/dashboardCharts.mjs'

const props = defineProps({ modelValue: { type: String, default: 'line' } })
const emit = defineEmits(['update:modelValue'])
const selected = computed(() => DASHBOARD_CHARTS.find(chart => chart.id === props.modelValue))
function select(value) {
  if (DASHBOARD_CHARTS.some(chart => chart.id === value)) emit('update:modelValue', value)
}
</script>

<template>
  <label class="chart-type-control">图表形式
    <select :value="modelValue" aria-label="图表类型" @change="select($event.target.value)">
      <option v-if="!selected" :value="modelValue" disabled hidden>旧版图表（请选择常用形式）</option>
      <option v-for="chart in DASHBOARD_CHARTS" :key="chart.id" :value="chart.id">{{chart.label}}</option>
    </select>
    <small class="field-hint">{{selected?.hint || '已有旧版图表保持兼容；现在可选择上面五种常用形式，数据绑定不会改变。'}}</small>
  </label>
</template>

<style scoped>
.chart-type-control { display:grid; gap:5px; min-width:0; color:#515154; font-size:calc(12px * var(--admin-font-scale,1)); }
.chart-type-control select { box-sizing:border-box; width:100%; min-height:36px; padding:6px 8px; border:1px solid #d8d8dd; border-radius:7px; outline:none; color:#1d1d1f; background:#fff; font-family:inherit; font-size:calc(13px * var(--admin-font-scale,1)); }
.chart-type-control select:focus-visible { border-color:#86868b; box-shadow:0 0 0 3px rgba(0,0,0,.06); }
.field-hint { display:block; color:#6e6e73; font-size:calc(11px * var(--admin-font-scale,1)); line-height:1.6; }
</style>
