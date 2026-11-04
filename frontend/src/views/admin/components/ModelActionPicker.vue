<script setup>
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { modelPackageActions, toggleModelSelection } from '../utils/modelPackageSelection.js'
const props = defineProps({ models: { type: Array, default: () => [] }, modelValue: { type: Array, default: () => [] }, disabled: Boolean })
const emit = defineEmits(['update:modelValue'])
const root = ref(null), open = ref(false), query = ref(''), active = ref(0), notice = ref('')
const listId = `model-options-${useId()}`
const options = computed(() => props.models.map(model => ({ ...model, actions: modelPackageActions(model) })))
const filtered = computed(() => options.value.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.value.toLowerCase())))
const selected = computed(() => props.modelValue.map(id => options.value.find(m => m.id === id)).filter(Boolean))
const hovered = computed(() => open.value ? filtered.value[active.value] : null)
function toggle(id) {
  if (props.disabled) return
  try { emit('update:modelValue', toggleModelSelection(props.modelValue, id)); notice.value = '' }
  catch (error) { notice.value = error.message }
}
function keys(event) {
  if (props.disabled) return
  if (event.key === 'Escape') { if (open.value) { event.preventDefault(); event.stopPropagation(); open.value = false } return }
  if (event.target.tagName !== 'INPUT') return
  if (event.key === 'Backspace' && !query.value && props.modelValue.length) { event.preventDefault(); toggle(props.modelValue.at(-1)); return }
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); open.value = true
    active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + filtered.value.length) % Math.max(1, filtered.value.length)
    root.value?.querySelector(`#${listId}-${active.value}`)?.scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter') { event.preventDefault(); if (open.value && hovered.value) toggle(hovered.value.id); else open.value = true }
}
function outside(event) { if (!root.value?.contains(event.target)) open.value = false }
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>
<template>
  <div ref="root" class="model-action-picker" @keydown="keys">
    <div class="model-tag-field" :class="{ disabled }">
      <span v-for="model in selected" :key="model.id" class="model-choice-tag" :title="model.name"><span>{{ model.name }}</span><button type="button" :aria-label="`移除 ${model.name}`" :disabled="disabled" @click="toggle(model.id)">×</button></span>
      <input type="text" role="combobox" aria-label="选择导出模型" :aria-expanded="open" :aria-controls="listId" :aria-activedescendant="open && filtered.length ? `${listId}-${active}` : undefined" aria-autocomplete="list" :disabled="disabled" :placeholder="selected.length ? '继续选择…' : '搜索或选择模型'" v-model="query" @input="active=0;open=true" @focus="open=true" @click="open=true" />
    </div>
    <div v-if="open && !disabled" class="model-options-panel">
      <ul :id="listId" role="listbox" aria-label="可导出的模型" aria-multiselectable="true">
        <li v-for="(model,index) in filtered" :id="`${listId}-${index}`" :key="model.id" :data-model-id="model.id" role="option" :aria-selected="modelValue.includes(model.id)" :class="{ active: active===index }" :title="model.actions.map(a=>a.name).join('、') || '暂无动作'" @mouseenter="active=index" @mousedown.prevent @click="toggle(model.id)"><i aria-hidden="true">{{ modelValue.includes(model.id) ? '✓' : '' }}</i><span>{{ model.name }}</span><small>{{ model.actions.length }} 个动作</small></li>
        <li v-if="!filtered.length" class="empty">没有匹配的模型</li>
      </ul>
      <p v-if="hovered" class="model-actions-tooltip" role="tooltip">{{ hovered.actions.map(a=>a.name).join('、') || '暂无动作' }}</p>
    </div>
    <p v-if="notice" role="alert">{{ notice }}</p>
  </div>
</template>
<style scoped>
.model-action-picker{position:relative;min-width:0}.model-tag-field{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:40px;padding:6px 9px;border:1px solid #cfd8e5;border-radius:9px;background:#fff}.model-tag-field:focus-within{border-color:#4f8fe8;box-shadow:0 0 0 3px #2563eb15}.model-tag-field.disabled{background:#f5f6f8}.model-tag-field input{flex:1;min-width:130px;width:100%;height:28px;padding:0;border:0;outline:0;background:transparent;font:inherit}.model-choice-tag{display:flex;align-items:center;gap:5px;max-width:100%;padding:3px 6px 3px 9px;border:1px solid #d9e5fb;border-radius:6px;background:#edf4ff;color:#2457a6;font-size:calc(12px * var(--admin-font-scale, 1))}.model-choice-tag>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.model-choice-tag button{padding:0;width:20px;height:22px;background:transparent;border:0;color:inherit;cursor:pointer;font:inherit}.model-options-panel{position:relative;margin-top:5px;border:1px solid #dce3ec;border-radius:9px;box-shadow:0 6px 20px #17203314;background:#fff;overflow:hidden}.model-options-panel ul{list-style:none;margin:0;padding:4px;max-height:220px;overflow:auto}.model-options-panel li{display:flex;align-items:center;gap:8px;padding:9px 8px;border-radius:6px;cursor:pointer;line-height:1.5}.model-options-panel li.active{background:#eef4ff}.model-options-panel li>span{flex:1;min-width:0;overflow-wrap:anywhere}.model-options-panel li i{flex:none;display:grid;place-items:center;width:15px;height:15px;border:1px solid #c5d2e5;border-radius:4px;color:#2563eb;font-style:normal}.model-options-panel li[aria-selected=true] i{background:#2563eb;border-color:#2563eb;color:#fff}.model-options-panel small{flex:none;color:#7b8ca3;font-size:calc(12px * var(--admin-font-scale, 1))}.model-actions-tooltip{padding:10px 12px;margin:0;border-top:1px solid #edf0f5;color:#64748b;font-size:calc(12px * var(--admin-font-scale, 1));line-height:1.6;overflow-wrap:anywhere;max-height:110px;overflow:auto}.empty{color:#8b96a6} [role=alert]{color:#b42318;font-size:calc(12px * var(--admin-font-scale, 1))}
</style>
