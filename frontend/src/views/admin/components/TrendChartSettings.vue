<script setup>
import { computed } from 'vue'
const props = defineProps({ content: {type:Object,required:true}, unit:String })
const emit = defineEmits(['change'])
const cartesian = computed(() => !['pie','donut','rose','funnel','radar','gauge','heatmap','candlestick','boxplot','waterfall'].includes(props.content.chartType))
const invalidRange = computed(() => props.content.yAxisMode === 'fixed' && (!(Number(props.content.yMin) < Number(props.content.yMax)) || props.content.yMin === '' || props.content.yMax === ''))
function set(key,value) {
  props.content[key]=value
  if(key==='timeWindowSeconds')props.content.historyLength=Math.min(600,Math.max(8,Math.ceil(value)))
  emit('change')
}
</script>
<template>
  <section v-if="cartesian" class="trend-settings" aria-label="图表坐标与时间">
    <strong>数值轴 · {{unit || '数值'}}</strong>
    <label>范围<select aria-label="数值轴范围" :value="content.yAxisMode || 'auto'" @change="set('yAxisMode',$event.target.value)"><option value="auto">自动适配数据</option><option value="fixed">固定范围</option></select></label>
    <div v-if="content.yAxisMode==='fixed'" class="pair">
      <label>最小值<input aria-label="数值轴最小值" type="number" step="any" :value="content.yMin" @change="set('yMin',$event.target.value===''?'':Number($event.target.value))" /></label>
      <label>最大值<input aria-label="数值轴最大值" type="number" step="any" :value="content.yMax" @change="set('yMax',$event.target.value===''?'':Number($event.target.value))" /></label>
    </div>
    <small v-if="invalidRange" role="alert">最大值须大于最小值；修正前使用自动范围。</small>
    <label v-if="content.yAxisMode!=='fixed'" class="check"><input type="checkbox" :checked="content.yIncludeZero===true" @change="set('yIncludeZero',$event.target.checked)" /> 数值轴包含零点</label>
    <div class="pair"><label>轴标题<input aria-label="数值轴标题" :placeholder="unit || '数值'" :value="content.yAxisTitle" @change="set('yAxisTitle',$event.target.value)" /></label><label>刻度小数位<input aria-label="刻度小数位" type="number" min="0" max="4" :value="content.yDecimals ?? 1" @change="set('yDecimals',Math.max(0,Math.min(4,Number($event.target.value))))" /></label></div>
    <label class="check"><input type="checkbox" :checked="content.showGrid!==false" @change="set('showGrid',$event.target.checked)" /> 显示网格线</label>
    <strong>时间轴</strong>
    <div class="pair"><label>实时窗口（分钟）<input aria-label="实时窗口分钟" type="number" min="1" max="10" :value="(content.timeWindowSeconds || 600)/60" @change="set('timeWindowSeconds',Math.max(60,Math.min(600,Number($event.target.value)*60)))" /></label><label>时间格式<select aria-label="时间轴格式" :value="content.timeFormat || 'time'" @change="set('timeFormat',$event.target.value)"><option value="time">时:分:秒</option><option value="dateTime">月-日 时:分:秒</option></select></label></div>
    <small class="note">实时窗口从打开页面后累积；轮播时各设备独立记录，断线留空。</small>
  </section>
</template>
<style scoped>
.trend-settings{display:grid;gap:10px;padding:12px;border:1px solid #dce5f1;border-radius:9px;background:#f8faff;font-size:calc(12px * var(--admin-font-scale, 1));color:#50657f}.trend-settings strong{font-size:calc(12px * var(--admin-font-scale, 1));color:#344a66}.trend-settings label{display:grid;gap:6px;min-width:0}.trend-settings input:not([type=checkbox]),.trend-settings select{width:100%;min-width:0;box-sizing:border-box;padding:8px;border:1px solid #d5dfed;background:#fff;border-radius:6px;color:#344a66;font:inherit}.pair{display:grid;grid-template-columns:1fr 1fr;gap:9px}.trend-settings .check{display:flex;align-items:center;gap:6px}.trend-settings small{font-size:calc(11px * var(--admin-font-scale, 1));color:#a46337;line-height:1.6}.trend-settings .note{color:#8492a7}
</style>
