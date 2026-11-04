<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'

const props = defineProps({ model: { type: Object, required: true }, disabled: Boolean })
const emit = defineEmits(['renamed', 'error', 'saving'])
const canEdit = computed(() => canAdminPage('models', 'edit'))
const editing = ref(false), saving = ref(false), saved = ref(false), draft = ref('')
const input = ref(null), trigger = ref(null)
let generation = 0
watch(() => props.model.name, name => { if (!editing.value) draft.value = name || '' })
onUnmounted(() => { generation++; if (saving.value) emit('saving', false) })
async function edit() {
  if (!canEdit.value || props.disabled || saving.value) return
  draft.value = props.model.name || ''; saved.value = false; editing.value = true
  await nextTick(); input.value?.focus(); input.value?.select()
}
async function cancel() {
  if (saving.value) return
  editing.value = false; draft.value = props.model.name || ''
  await nextTick(); trigger.value?.focus()
}
async function save() {
  if (!editing.value || !canEdit.value || props.disabled || saving.value) return
  const name = draft.value.trim(), id = props.model.id
  if (!name || name.length > 120) return emit('error', '模型名称需为 1–120 个字符')
  if (name === props.model.name) return cancel()
  const current = ++generation
  saving.value = true; emit('saving', true)
  try {
    // Never submit a stale copy of metadata, bindings, file path or model ID.
    const result = await adminApi.renameModel(id, name)
    if (current !== generation) return
    if (result?.error || result?.success !== true || result.model?.id !== id || typeof result.model?.name !== 'string') throw new Error(result?.error || '后端未确认名称保存')
    emit('renamed', { id, name: result.model.name })
    editing.value = false; saved.value = true
    await nextTick(); trigger.value?.focus()
  } catch (cause) { if (current === generation) emit('error', cause.message || '模型名称保存失败') }
  finally { if (current === generation) { saving.value = false; emit('saving', false) } }
}
</script>

<template>
  <div class="model-name-editor" @click.stop @keydown.stop>
    <form v-if="editing" class="model-name-form" @submit.prevent="save">
      <input ref="input" v-model="draft" class="input model-name-input" aria-label="模型名称" maxlength="120" :disabled="saving || disabled" @keydown.enter.prevent="save" @keydown.esc.prevent="cancel" />
      <button type="submit" class="btn btn-sm model-name-action" aria-label="保存模型名称" title="保存名称" :disabled="saving || disabled || draft.trim() === model.name">{{ saving ? '…' : '✓' }}</button>
      <button type="button" class="btn btn-sm model-name-action" aria-label="取消修改名称" title="取消" :disabled="saving" @click="cancel">×</button>
    </form>
    <template v-else>
      <button v-if="canEdit" ref="trigger" type="button" class="model-name-trigger" :aria-label="`修改模型名称：${model.name || model.id}`" :title="model.name" :disabled="disabled" @click="edit">
        <span>{{ model.name || model.id }}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 3.5 4 4-9 9H3.5v-4zM10 6l4 4" /></svg>
      </button>
      <span v-else class="model-name-text" :title="model.name">{{ model.name || model.id }}</span>
      <span v-if="saved" class="model-name-saved" role="status" aria-label="模型名称已保存" title="已保存">✓</span>
    </template>
  </div>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.model-name-editor, .model-name-form { display: flex; align-items: center; gap: 4px; min-width: 0; width: 100%; }
.model-name-trigger { display: flex; align-items: center; justify-content: space-between; gap: 7px; min-width: 0; width: 100%; padding: 5px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
.model-name-trigger span, .model-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-name-trigger svg { flex-shrink: 0; width: 14px; height: 14px; fill: none; stroke: #8191a7; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.model-name-trigger:hover:not(:disabled) { color: #2457a6; }
.model-name-trigger:disabled { opacity: .6; cursor: wait; }
.model-name-input { flex: 1; min-width: 0; width: 100%; height: 30px; padding: 4px 6px; border-radius: 6px; font-family: inherit; font-size: calc(12px * var(--admin-font-scale, 1)); box-sizing: border-box; }
.model-name-action { flex-shrink: 0; min-width: 25px; height: 30px; padding: 4px 6px; }
.model-name-saved { flex-shrink: 0; color: #16815b; font-size: calc(12px * var(--admin-font-scale, 1)); }
</style>
