<script setup>
import { computed } from 'vue'
import { systemSourceTrace, widgetSourceTrace } from '../../../runtime/widgetSourceTrace.js'
const props = defineProps({ widget: Object, devices: { type: Array, default: () => [] }, points: { type: Array, default: () => [] }, datasets: { type: Array, default: () => [] }, connections: { type: Array, default: () => [] }, viewId: String, open: Boolean })
const rows = computed(() => props.widget ? widgetSourceTrace(props.widget, props) : systemSourceTrace())
</script>
<template>
  <details class="widget-source-trace" :open="open" :aria-label="widget ? '组件数据与内容来源' : '系统信息来源'">
    <summary>{{ widget ? '数据与内容来源' : '系统信息来源' }} <small>{{ rows.length }} 项 · 只读说明</small></summary>
    <p>{{ widget ? '逐项说明显示内容来自哪里、使用哪个字段、属于哪个工厂或设备、如何更新。固定文案在“内容”修改，数据绑定在“数据来源”设置；系统与计算字段只说明真实规则，不会自动改动绑定。' : '按实际渲染面说明系统信息；工厂名称、采集状态和场景上下文不一定来自同一个字段，也不是一条 PLC 点位。' }}</p>
    <ol>
      <li v-for="row in rows" :key="row.key || row.field">
        <strong>{{ row.field }}</strong><span class="source-origin">{{ row.origin }}</span>
        <div>{{ row.source }}</div><code v-if="row.path">{{ row.path }}</code>
        <small><template v-if="row.scope">范围：{{ row.scope }} · </template>更新：{{ row.updates }}</small>
      </li>
    </ol>
  </details>
</template>
<style scoped>
.widget-source-trace{min-width:0;max-width:100%;box-sizing:border-box;border:1px solid #dce6f3;border-radius:8px;padding:10px;color:#41536d;background:#f8fbff;font-size:11px;line-height:1.6}.widget-source-trace summary{cursor:pointer;font-weight:600;color:#344d70}.widget-source-trace summary small{font-size:10px;font-weight:400;color:#8291a6}.widget-source-trace p{margin:9px 0;color:#7c8ca4}.widget-source-trace ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}.widget-source-trace li{min-width:0;padding-top:8px;border-top:1px solid #e2e8f3;overflow-wrap:anywhere;word-break:break-word}.widget-source-trace strong{font-size:11px}.widget-source-trace .source-origin{display:inline-block;margin-left:6px;border-radius:4px;padding:0 4px;background:#eaf2ff;color:#3565a5;font-size:10px}.widget-source-trace code{display:block;font-size:10px;white-space:pre-wrap;color:#607ba2;overflow-wrap:anywhere}.widget-source-trace li>small{display:block;margin-top:3px;color:#8291a6}.widget-source-trace:focus-within{outline:2px solid #82aaff;outline-offset:2px}
</style>
