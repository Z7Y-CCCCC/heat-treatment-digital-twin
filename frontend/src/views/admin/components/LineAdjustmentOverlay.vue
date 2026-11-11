<script setup>
import { computed } from 'vue'
import { lineAdjustmentBandStyle } from '../../../../../shared/lineAdjustmentBand.mjs'
const props = defineProps({ band: { type: Object, required: true }, bounds: { type: Object, required: true }, length: { type: Number, required: true } })
const style = computed(() => lineAdjustmentBandStyle(props.band, props.bounds, props.length))
</script>
<template>
  <div class="line-adjustment-band" :class="{ 'outside-band': !band.currentInside }" :style="style" :data-adjustment-lane-id="band.laneId" role="note" :aria-label="`${band.name}红色虚线微调范围`">
    <span class="adjustment-band-caption">{{ band.name }} · 可微调范围 <small>中心距 {{ band.minDistanceMeters.toFixed(2) }}–{{ band.maxDistanceMeters.toFixed(2) }} m</small></span>
  </div>
</template>
<style scoped>
.line-adjustment-band{position:absolute;z-index:2;box-sizing:border-box;border:2px dashed #d34e53;border-radius:12px;background:rgba(211,78,83,.035);pointer-events:none;user-select:none}
.adjustment-band-caption{position:absolute;left:12px;top:-14px;max-width:calc(100% - 24px);padding:3px 9px;border:1px solid #f0ced0;border-radius:5px;background:#fff7f7;color:#a9373d;font-size:calc(13px * var(--admin-font-scale,1));font-weight:600;line-height:1.5;white-space:normal;overflow-wrap:anywhere}
.adjustment-band-caption small{font-size:inherit;font-weight:400;margin-left:7px}.outside-band{background:rgba(211,78,83,.065)}
</style>
