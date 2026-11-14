<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import InspectionVectorInput from './InspectionVectorInput.vue'
const props = defineProps({ permissionPage: { type: String, default: 'models' }, modelValue: { type: Object, required: true }, label: { type: String, default: '镜头' } })
const emit = defineEmits(['update:modelValue', 'capture'])
function set(key, value) { emit('update:modelValue', { ...props.modelValue, [key]: value }) }
</script>

<template>
    <div class="inspection-camera-fields">
        <div class="camera-numbers">
            <label>水平角 °<input type="number" step="1" :aria-label="`${label}水平角`" :value="modelValue.yaw" @input="set('yaw', Number($event.target.value))"  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <label>俯仰角 °<input type="number" min="-89" max="89" step="1" :aria-label="`${label}俯仰角`" :value="modelValue.pitch" @input="set('pitch', Number($event.target.value))"  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <label>距离倍率<input type="number" min="0.05" max="20" step="0.05" :aria-label="`${label}距离倍率`" :value="modelValue.distance_scale" @input="set('distance_scale', Number($event.target.value))"  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
        </div>
        <InspectionVectorInput :permission-page="permissionPage" :model-value="modelValue.target_offset" label="观察中心偏移" @update:model-value="set('target_offset', $event)" />
        <button class="camera-capture" type="button" @click="emit('capture')" v-permission="{ page: permissionPage, action: 'edit' }">记录当前预览镜头</button>
    </div>
</template>

<style scoped>
.inspection-camera-fields { display: grid; gap: 10px; }
.camera-numbers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
label { display: grid; gap: 6px; color: #475467; font-size: calc(13px * var(--admin-font-scale, 1)); min-width: 0; }
input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #d5dfe6; border-radius: 6px; padding: 7px; color: #223d4c; background: #fff; font-size: calc(14px * var(--admin-font-scale, 1)); }
.camera-capture { justify-self: start; padding: 6px 10px; border: 1px solid #a9cbd5; border-radius: 6px; background: #edf8fb; color: #23687a; font-size: calc(13px * var(--admin-font-scale, 1)); cursor: pointer; }
</style>
