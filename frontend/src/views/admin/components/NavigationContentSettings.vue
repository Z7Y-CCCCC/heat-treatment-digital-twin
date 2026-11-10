<script setup>
import { computed, useId } from 'vue'
import { resolveNavigationContent } from '../../../runtime/widgetContentConfig.js'

const props = defineProps({ content: { type: Object, default: () => ({}) }, systemData: { type: Object, default: () => ({}) }, disabled: Boolean })
const emit = defineEmits(['update', 'commit'])
const id = useId()
const resolved = computed(() => resolveNavigationContent({ content: props.content }, props.systemData))
const projectSource = computed(() => props.content.projectLabelSource === 'factory' ? 'factory' : 'fixed')
const statusSource = computed(() => props.content.statusTextSource === 'collection' ? 'collection' : 'fixed')
function update(field, value) { if (!props.disabled) emit('update', { field, value }) }
function source(field, value) { if (props.disabled) return; update(field, value); emit('commit') }
function commit() { if (!props.disabled) emit('commit') }
</script>

<template>
  <div class="navigation-content-settings">
    <div class="navigation-content-field">
      <label :for="`${id}-project-source`">项目文字</label>
      <select :id="`${id}-project-source`" :value="projectSource" :disabled="disabled" aria-label="项目文字来源" @change="source('projectLabelSource', $event.target.value)">
        <option value="fixed">自定义文字</option><option value="factory">当前工厂名称</option>
      </select>
      <input v-if="projectSource === 'fixed'" :value="content.projectLabel ?? ''" :disabled="disabled" aria-label="项目文字" @input="update('projectLabel', $event.target.value)" @change="commit" />
      <input v-else :value="resolved.projectLabel" readonly aria-label="当前工厂名称" />
    </div>
    <div class="navigation-content-field">
      <label :for="`${id}-status-source`">状态文字</label>
      <select :id="`${id}-status-source`" :value="statusSource" :disabled="disabled" aria-label="状态文字来源" @change="source('statusTextSource', $event.target.value)">
        <option value="fixed">自定义文字</option><option value="collection">当前采集状态</option>
      </select>
      <input v-if="statusSource === 'fixed'" :value="content.statusText ?? ''" :disabled="disabled" aria-label="状态文字" @input="update('statusText', $event.target.value)" @change="commit" />
      <input v-else :value="resolved.statusText" readonly aria-label="当前采集状态" />
    </div>
  </div>
</template>

<style scoped>
.navigation-content-settings{display:grid;gap:14px;min-width:0}
.navigation-content-field{display:grid;gap:6px;min-width:0}
.navigation-content-field label{font-size:12px;color:#68778c}
.navigation-content-field input,.navigation-content-field select{box-sizing:border-box;min-width:0;width:100%;padding:9px 10px;border:1px solid #d9e1ed;border-radius:8px;background:#fff;color:#26354d;font:inherit;font-size:12px}
.navigation-content-field input[readonly]{background:#f4f6fa;color:#596a80}
.navigation-content-field :disabled{opacity:.65}
</style>
