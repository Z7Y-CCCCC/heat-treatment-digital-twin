<script setup>
import { computed } from 'vue'
const props = defineProps({ state: { type: Object, default: () => ({}) } })
const emit = defineEmits(['command'])
const selected = computed(() => props.state.parts?.find(part => part.id === props.state.selectedId))
const labels = computed(() => {
    if (!props.state.labelsEnabled) return []
    const points = (props.state.parts || []).filter(part => part.anchor?.visible && part.label?.visible)
        .map(part => ({ ...part, x: part.label.x >= 0.5 ? 0.96 : 0.04, y: Math.max(0.12, Math.min(0.88, part.label.y)) }))
    // Keep names legible without detaching their leader from the projected world-space anchor.
    for (const side of [0, 1]) {
        const column = points.filter(part => Number(part.x >= 0.5) === side).sort((a, b) => a.y - b.y)
        const gap = Math.min(0.055, 0.76 / Math.max(column.length, 1))
        for (let index = 1; index < column.length; index++) column[index].y = Math.max(column[index].y, column[index - 1].y + gap)
        if (column.at(-1)?.y > 0.88) {
            column.at(-1).y = 0.88
            for (let index = column.length - 2; index >= 0; index--) column[index].y = Math.min(column[index].y, column[index + 1].y - gap)
        }
    }
    return points
})
</script>

<template>
    <div class="inspection-preview-overlay">
        <div class="preview-stage-caption">
            <b>{{ state.stage === 'exploded' ? '分解装配' : state.stage === 'xray' ? '外壳透视' : '完整设备' }}</b>
            <span>{{ state.animating ? (state.phase === 'shell' ? '外壳过渡' : '部件展开 / 还原') : state.paused ? '已暂停，可拖动进度' : '拖动旋转 · 滚轮缩放 · 点击部件特写' }}</span>
        </div>
        <svg v-if="state.leaderLines && state.labelsEnabled" class="inspection-leaders" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <g v-for="part in labels" :key="part.id" :class="{ selected: part.selected }">
                <line :x1="part.anchor.x * 100" :y1="part.anchor.y * 100" :x2="part.x * 100" :y2="part.y * 100" />
                <circle :cx="part.anchor.x * 100" :cy="part.anchor.y * 100" r="0.38" />
            </g>
        </svg>
        <button v-for="part in labels" :key="part.id" type="button" class="spatial-part-label" :class="{ selected: part.selected, hovered: part.hovered, right: part.x >= 0.5 }" :style="{ left: `${part.x * 100}%`, top: `${part.y * 100}%` }" :title="part.description || part.name" @click="emit('command', { command: 'select', partId: part.id })">{{ part.name }}</button>
        <div v-if="selected" class="preview-part-detail">
            <header><strong>{{ selected.name }}</strong><button type="button" aria-label="返回整体镜头" @click="emit('command', {command: 'clear'})">×</button></header>
            <p v-if="selected.description">{{ selected.description }}</p>
            <small v-if="selected.group">{{ selected.group }}</small>
            <div v-if="selected.point_keys?.length || selected.point_ids?.length" class="preview-point-links"><span>已关联 PLC 点位</span><code v-for="key in [...(selected.point_keys || []), ...(selected.point_ids || [])]" :key="key">{{ key }}</code></div>
            <button type="button" @click="emit('command', { command: 'isolate', enabled: !state.isolated })">{{ state.isolated ? '显示全部部件' : '突出当前部件' }}</button>
        </div>
    </div>
</template>

<style scoped>
.inspection-preview-overlay { position: absolute; z-index: 3; inset: 0; overflow: hidden; pointer-events: none; }
.preview-stage-caption { position: absolute; top: 14px; left: 14px; display: grid; gap: 5px; color: #c3dce7; font-size: 12px; text-shadow: 0 1px 3px #001821; }
.preview-stage-caption b { color: #f1fbff; font-size: 15px; }
.inspection-leaders { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
line { stroke: #7ca6b7; stroke-width: 0.7; vector-effect: non-scaling-stroke; }
circle { fill: #b8e5ed; }
.selected line { stroke: #37e0ed; stroke-width: 1.4; }
.selected circle { fill: #37e0ed; }
.spatial-part-label { position: absolute; max-width: min(180px, 40%); padding: 5px 8px; border-radius: 5px; border: 1px solid #426170; background: #102a3bee; color: #e1eff5; font-size: 14px; cursor: pointer; pointer-events: auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; transform: translateY(-50%); box-shadow: 0 2px 8px #0004; }
.spatial-part-label.right { transform: translate(-100%, -50%); }
.spatial-part-label.selected, .spatial-part-label.hovered, .spatial-part-label:hover { color: #f4ffff; background: #07576b; border-color: #3ed4e5; z-index: 2; }
.preview-part-detail { position: absolute; bottom: 12px; left: 12px; right: 12px; max-height: 185px; overflow: auto; border: 1px solid #517487; border-radius: 8px; padding: 10px 12px; color: #d9e9f1; background: #102536f2; pointer-events: auto; box-shadow: 0 6px 20px #0003; font-size: 13px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
header strong { font-size: 15px; }
header button { border: none !important; background: transparent !important; font-size: 20px !important; padding: 0 4px !important; }
p { margin: 8px 0; line-height: 1.5; }
small { color: #a0becc; }
.preview-point-links { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
.preview-point-links span { width: 100%; color: #9cc3d3; font-size: 12px; }
code { padding: 3px 5px; border-radius: 4px; background: #244051; color: #9de5ed; font-size: 11px; overflow-wrap: anywhere; }
.preview-part-detail button { margin-top: 4px; padding: 5px 8px; color: #cefbff; border: 1px solid #3b7689; border-radius: 5px; background: #1b4152; font-size: 12px; cursor: pointer; }
</style>
