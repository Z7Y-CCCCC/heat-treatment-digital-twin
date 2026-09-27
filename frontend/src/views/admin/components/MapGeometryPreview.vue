<script setup>
import { computed, ref, watch } from 'vue'
import { mapPreviewShapes, mapPreviewUrls } from '../../../runtime/mapPreviewGeometry.js'

const props = defineProps({ level: { type: String, required: true }, location: { type: Object, default: () => ({}) } })
const shapes = ref([])
const status = ref('正在载入地图轮廓…')
const selectedCode = computed(() => props.location.country && props.location.country !== 'CHN'
    ? String(props.location.country)
    : props.level === 'world' ? 'CHN' : props.level === 'country' ? String(props.location.regionCode || '') : props.level === 'province' ? String(props.location.cityCode || '') : String(props.location.districtCode || ''))
let requestVersion = 0
const cache = new Map()

watch(() => [props.level, props.location.country, props.location.regionCode, props.location.cityCode, props.location.districtCode], async () => {
    const version = ++requestVersion
    shapes.value = []
    status.value = '正在载入地图轮廓…'
    for (const url of mapPreviewUrls(props.level, props.location)) {
        try {
            let data = cache.get(url)
            if (!data) {
                const response = await fetch(url)
                if (!response.ok) continue
                data = await response.json()
                cache.set(url, data)
            }
            if (version !== requestVersion) return
            shapes.value = mapPreviewShapes(data, selectedCode.value)
            status.value = shapes.value.length ? '' : '此层地图暂无可用轮廓'
            if (shapes.value.length) return
        } catch { /* Try the next local outline; never open another dashboard. */ }
    }
    if (version === requestVersion) status.value = '地图轮廓暂不可用，组件仍可配置'
}, { immediate: true })
</script>

<template>
    <div class="map-geometry-preview" aria-hidden="true">
        <svg v-if="shapes.length" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet"><path v-for="shape in shapes" :key="shape.id" :d="shape.d" :class="{selected:shape.selected}" /></svg>
        <span v-else>{{ status }}</span>
        <em v-if="location.country && location.country!=='CHN' && !['world','country'].includes(level)">境外细分行政轮廓未接入，预览仅显示国家范围</em>
    </div>
</template>

<style scoped>
.map-geometry-preview{position:absolute;inset:3% 10% 5%;display:grid;place-items:center;pointer-events:none}.map-geometry-preview svg{width:100%;height:100%;overflow:visible}.map-geometry-preview path{fill:color-mix(in srgb,var(--preview-map-base) 50%,transparent);stroke:color-mix(in srgb,var(--preview-accent) 37%,transparent);stroke-width:1.3;vector-effect:non-scaling-stroke}.map-geometry-preview path.selected{fill:color-mix(in srgb,var(--preview-accent) 42%,var(--preview-map-base));stroke:var(--preview-accent);stroke-width:1.8}.map-geometry-preview span{font-size:12px;color:var(--preview-text);opacity:.5}
.map-geometry-preview em{position:absolute;left:0;bottom:2px;color:var(--preview-text);font-size:10px;font-style:normal;opacity:.6}
</style>
