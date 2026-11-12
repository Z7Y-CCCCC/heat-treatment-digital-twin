<script setup>
import { computed, ref } from 'vue'
import { chartTickError } from '../../../runtime/trendChart.js'
const props = defineProps({ content: {type:Object,required:true}, unit:String })
const emit = defineEmits(['change'])
const cartesian = computed(() => !['pie','donut','rose','funnel','radar','gauge','heatmap','candlestick','boxplot','waterfall'].includes(props.content.chartType))
const invalidRange = computed(() => props.content.yAxisMode === 'fixed' && (!(Number(props.content.yMin) < Number(props.content.yMax)) || props.content.yMin === '' || props.content.yMax === ''))
const tickError = computed(() => chartTickError(props.content))
const windowError=ref('')
function setWindowMinutes(event){
  const seconds=Number(event.target.value)*60
  if(!Number.isSafeInteger(seconds) || seconds<60 || seconds>8640000000000){windowError.value='实时窗口须为至少 1 分钟的有效时长。';return}
  windowError.value='';set('timeWindowSeconds',seconds)
}
function set(key,value) {
  props.content[key]=value
  if(key==='timeWindowSeconds')props.content.historyLength=Math.min(20000,Math.max(2000,Math.ceil(value)))
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
    <label>Y 轴刻度间隔<input aria-label="Y轴刻度间隔" type="number" min="0" step="any" placeholder="自动，例如 5" :value="content.yTickInterval ?? ''" @change="set('yTickInterval',$event.target.value===''?'':Number($event.target.value))" /></label>
    <small class="note">例如填写 5，每格相差 5{{unit || ' 个单位'}}；留空自动适配。</small>
    <label v-if="content.yAxisMode!=='fixed'" class="check"><input type="checkbox" :checked="content.yIncludeZero===true" @change="set('yIncludeZero',$event.target.checked)" /> 数值轴包含零点</label>
    <div class="pair"><label>轴标题<input aria-label="数值轴标题" :placeholder="unit || '数值'" :value="content.yAxisTitle" @change="set('yAxisTitle',$event.target.value)" /></label><label>刻度小数位<input aria-label="刻度小数位" type="number" min="0" max="4" :value="content.yDecimals ?? 1" @change="set('yDecimals',Math.max(0,Math.min(4,Number($event.target.value))))" /></label></div>
    <label class="check"><input type="checkbox" :checked="content.showGrid!==false" @change="set('showGrid',$event.target.checked)" /> 显示网格线</label>
    <strong>时间轴</strong>
    <label>X 轴刻度<select aria-label="X轴刻度模式" :value="content.xTickMode || 'auto'" @change="set('xTickMode',$event.target.value)"><option value="auto">自动间隔</option><option value="time">按时间间隔</option><option value="category">按数据项间隔</option></select></label>
    <label v-if="content.xTickMode==='time'">时间刻度间隔（秒）<input aria-label="X轴时间刻度间隔秒" type="number" min="0" step="any" :value="content.xTickIntervalSeconds ?? 10" @change="set('xTickIntervalSeconds',Number($event.target.value))" /></label>
    <label v-if="content.xTickMode==='category'">每隔多少个数据项显示刻度<input aria-label="X轴数据项刻度间隔" type="number" min="1" step="1" :value="content.xLabelEvery ?? 1" @change="set('xLabelEvery',Number($event.target.value))" /></label>
    <small v-if="content.xTickMode==='time'" class="note">例如 10 表示每 10 秒一格，按真实时间距离绘制；分类数据请选择“按数据项间隔”。</small>
    <small v-if="tickError" role="alert">{{tickError}}</small>
    <div class="pair"><label>实时窗口（分钟）<input aria-label="实时窗口分钟" type="number" min="1" :value="(content.timeWindowSeconds || 600)/60" @change="setWindowMinutes" /></label><label>时间格式<select aria-label="时间轴格式" :value="content.timeFormat || 'time'" @change="set('timeFormat',$event.target.value)"><option value="time">时:分:秒</option><option value="dateTime">月-日 时:分:秒</option></select></label></div>
    <small v-if="windowError" role="alert">{{windowError}}</small>
    <small class="note">30 表示最近 30 分钟，60 表示最近 1 小时，可设置更长时段。窗口只影响显示，不修改后台保留策略；保留期内的已采集历史从后台补读，轮播按设备隔离，断线留空。记录开关及期限在数据中心的“趋势与历史记录”配置，默认近期 24 小时、长期按点位可选。超过保留期或未记录的时段留空；每轴最多 200 格，过密时自动调整刻度。</small>
  </section>
</template>
<style scoped>
.trend-settings{display:grid;gap:10px;padding:12px;border:1px solid #dce5f1;border-radius:9px;background:#f8faff;font-size:calc(12px * var(--admin-font-scale, 1));color:#50657f}.trend-settings strong{font-size:calc(12px * var(--admin-font-scale, 1));color:#344a66}.trend-settings label{display:grid;gap:6px;min-width:0}.trend-settings input:not([type=checkbox]),.trend-settings select{width:100%;min-width:0;box-sizing:border-box;padding:8px;border:1px solid #d5dfed;background:#fff;border-radius:6px;color:#344a66;font:inherit}.pair{display:grid;grid-template-columns:1fr 1fr;gap:9px}.trend-settings .check{display:flex;align-items:center;gap:6px}.trend-settings small{font-size:calc(11px * var(--admin-font-scale, 1));color:#a46337;line-height:1.6}.trend-settings .note{color:#8492a7}
</style>
