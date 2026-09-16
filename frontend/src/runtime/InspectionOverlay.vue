<script setup>
import { computed, ref } from 'vue'

const props = defineProps({ context: { type: Object, required: true }, selectedPart: { type: Object, default: () => ({}) }, error: { type: String, default: '' } })
const emit = defineEmits(['command'])
const listOpen = ref(false)
const parts = computed(() => props.context.inspectionParts || [])
const selected = computed(() => parts.value.find(part => part.id === props.context.partId))
const paused = computed(() => props.context.inspectionPhase === 'paused')
const stage = computed(() => props.context.inspectionStage)
const progress = computed(() => Math.round((props.context.inspectionProgress || 0) * 100))
const command = (command, fields = {}) => emit('command', { command, ...fields })
const labels = computed(() => {
    if (!props.context.inspectionLabelsEnabled) return []
    const result = parts.value.filter(part => part.anchor?.visible && part.label?.visible).map(part => ({
        ...part, x: part.label.x >= 0.5 ? 0.96 : 0.04, y: Math.max(0.10, Math.min(0.82, part.label.y))
    }))
    for (const right of [false, true]) {
        const column = result.filter(part => (part.x >= 0.5) === right).sort((a, b) => a.y - b.y)
        const gap = Math.min(0.052, 0.72 / Math.max(1, column.length))
        for (let index = 1; index < column.length; index++) column[index].y = Math.max(column[index].y, column[index - 1].y + gap)
        if (column.at(-1)?.y > 0.82) {
            column.at(-1).y = 0.82
            for (let index = column.length - 2; index >= 0; index--) column[index].y = Math.min(column[index].y, column[index + 1].y - gap)
        }
    }
    return result
})
const valueText = point => point.quality !== 'good' || point.value == null ? '—' : typeof point.value === 'number' ? point.value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : String(point.value)
</script>

<template>
    <section class="runtime-inspection" aria-label="设备拆解检查">
        <svg v-if="context.inspectionLeaderLines" class="runtime-inspection-leaders" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <g v-for="part in labels" :key="part.id" :class="{ selected: part.selected }">
                <line :x1="part.anchor.x * 100" :y1="part.anchor.y * 100" :x2="part.x * 100" :y2="part.y * 100" />
                <circle :cx="part.anchor.x * 100" :cy="part.anchor.y * 100" r="0.25" />
            </g>
        </svg>
        <button v-for="part in labels" :key="part.id" type="button" class="runtime-part-label" data-overlay-hit="true"
            :class="{ selected: part.selected, hovered: context.inspectionHoveredPartId === part.id, right: part.x >= 0.5 }"
            :style="{ left: `${part.x * 100}%`, top: `${part.y * 100}%` }" :title="part.description || part.name"
            @pointerdown.stop @click.stop="command('select', { partId: part.id })">{{ part.name }}</button>

        <aside v-if="selected" class="runtime-part-card" data-overlay-hit="true" @pointerdown.stop>
            <header><div><small>{{ selected.group || '部件检查' }}</small><h3>{{ selected.name }}</h3></div><button type="button" aria-label="返回设备整体" @click="command('clear')">×</button></header>
            <p v-if="selected.description">{{ selected.description }}</p>
            <dl v-if="selectedPart.points?.length" class="runtime-part-points">
                <div v-for="point in selectedPart.points" :key="point.id" :class="{ stale: point.quality !== 'good' }"><dt>{{ point.display_name || point.name || point.value_role }}</dt><dd>{{ valueText(point) }} <small>{{ point.unit || '' }}</small><em v-if="point.quality !== 'good'">数据未就绪</em></dd></div>
            </dl>
            <p v-else class="runtime-part-empty">此部件暂无已配置的实时点位。</p>
            <button type="button" class="isolate-button" @click="command('isolate', { enabled: !context.inspectionIsolated })">{{ context.inspectionIsolated ? '显示所有部件' : '单独查看此部件' }}</button>
        </aside>

        <div class="runtime-inspection-controls" data-overlay-hit="true" @pointerdown.stop>
            <div class="runtime-inspection-actions">
                <button type="button" :class="{ active: stage === 'solid' }" @click="command('stage', { stage: 'solid' })">反向组装</button>
                <button type="button" :class="{ active: stage === 'xray' }" @click="command('stage', { stage: 'xray' })">外壳透视</button>
                <button type="button" :class="{ active: stage === 'exploded' || stage === 'part' }" @click="command('stage', { stage: 'exploded' })">拆解展示</button>
                <button type="button" @click="command(paused ? 'resume' : 'pause')">{{ paused ? '继续' : '暂停' }}</button>
                <button type="button" :aria-pressed="context.inspectionLabelsEnabled" @click="command('labels', { enabled: !context.inspectionLabelsEnabled })">{{ context.inspectionLabelsEnabled ? '隐藏标签' : '显示标签' }}</button>
                <button type="button" :aria-expanded="listOpen" @click="listOpen = !listOpen">部件 {{ parts.length }}</button>
            </div>
            <label class="runtime-inspection-timeline"><span>{{ context.inspectionAnimating ? (context.inspectionPhase === 'shell' ? '外壳退场 / 还原' : '部件展开 / 还原') : paused ? '已暂停' : '拆解进度' }}</span><input type="range" min="0" max="1" step="0.001" :value="context.inspectionProgress || 0" aria-label="运行端拆解进度" @input="command('progress', { progress: Number($event.target.value) })" /><output>{{ progress }}%</output></label>
            <div v-if="listOpen" class="runtime-part-list"><button v-for="part in parts" :key="part.id" type="button" :class="{ active: part.selected }" @click="command('select', { partId: part.id })">{{ part.name }}</button></div>
            <p v-if="error" role="alert" class="inspection-command-error">{{ error }}</p>
            <details v-if="context.inspectionIssues?.length" class="inspection-runtime-issues"><summary>拆解配置提示（{{ context.inspectionIssues.length }}）</summary><p v-for="(issue, index) in context.inspectionIssues" :key="index">{{ issue.message || issue }}</p></details>
        </div>
    </section>
</template>

<style scoped>
.runtime-inspection { position: absolute; inset: 0; z-index: 40; pointer-events: none; color: #e4f3fa; font-size: 14px; }
.runtime-inspection-leaders { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.runtime-inspection-leaders line { stroke: #9dc6d8; stroke-width: 1; vector-effect: non-scaling-stroke; }
.runtime-inspection-leaders circle { fill: #a5d8e8; }
.runtime-inspection-leaders .selected line { stroke: #51e5f5; stroke-width: 2; }
button { font: inherit; cursor: pointer; color: #d9edf6; border: 1px solid #466577; background: #153449; border-radius: 6px; padding: 7px 10px; }
button:hover, button.active, button[aria-pressed="true"] { background: #18556a; color: #f0ffff; border-color: #58cfe2; }
button:focus-visible, input:focus-visible { outline: 2px solid #70eeff; outline-offset: 3px; }
.runtime-part-label { position: absolute; max-width: min(230px, 25vw); pointer-events: auto; transform: translateY(-50%); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; box-shadow: 0 3px 12px #0005; background: #102a3aeb; }
.runtime-part-label.right { transform: translate(-100%, -50%); }
.runtime-part-label.selected, .runtime-part-label.hovered { border-color: #6ceafa; background: #0c6076; color: white; z-index: 1; }
.runtime-inspection-controls { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); width: min(820px, calc(100% - 36px)); padding: 12px; border: 1px solid #426076; border-radius: 12px; background: #0c2233f2; box-shadow: 0 8px 28px #0005; pointer-events: auto; }
.runtime-inspection-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 7px; }
.runtime-inspection-timeline { display: flex; align-items: center; gap: 12px; margin-top: 12px; color: #b4cedc; }
.runtime-inspection-timeline input { flex: 1; min-width: 60px; accent-color: #49d9e9; }
.runtime-inspection-timeline output { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
.runtime-part-card { position: absolute; top: 58px; right: 20px; width: min(315px, 35vw); max-height: calc(100% - 220px); overflow: auto; padding: 16px; border: 1px solid #466779; border-radius: 10px; background: #0c2536f2; pointer-events: auto; box-shadow: 0 6px 24px #0004; }
.runtime-part-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.runtime-part-card header button { border: none; background: transparent; font-size: 24px; padding: 0 4px; }
.runtime-part-card small { color: #9dbdcd; font-size: 12px; }
.runtime-part-card h3 { font-size: 18px; margin: 4px 0 0; }
.runtime-part-card p { line-height: 1.65; color: #c0d6e2; }
.runtime-part-points { display: grid; gap: 10px; }
.runtime-part-points > div { padding-top: 10px; border-top: 1px solid #365365; display: flex; gap: 10px; justify-content: space-between; }
.runtime-part-points dt { color: #b1ccda; }
.runtime-part-points dd { margin: 0; font-variant-numeric: tabular-nums; }
.runtime-part-points em { display: block; font-style: normal; color: #e5bb76; font-size: 12px; }
.runtime-part-empty { color: #91acba !important; }
.isolate-button { width: 100%; }
.runtime-part-list { margin-top: 12px; padding-top: 12px; border-top: 1px solid #38596a; display: flex; gap: 6px; flex-wrap: wrap; max-height: 160px; overflow: auto; }
.inspection-command-error { color: #ffbab3; margin: 10px 0 0; }
.inspection-runtime-issues { color: #e7c68e; margin-top: 10px; max-height: 160px; overflow: auto; }
.inspection-runtime-issues p { margin: 7px 0; }
@media (max-width: 800px) { .runtime-part-card { width: min(270px, 46vw); right: 12px; } .runtime-inspection-controls { bottom: 10px; } .runtime-inspection-timeline { font-size: 12px; } }
</style>
