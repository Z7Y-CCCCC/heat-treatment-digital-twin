<script setup>
const props = defineProps({
    entries: { type: Array, default: () => [] },
    total: { type: Number, default: 0 },
    nodeCount: { type: Number, default: 0 },
    search: { type: String, default: '' },
    page: { type: Number, default: 1 },
    pageCount: { type: Number, default: 1 },
    activeBindingIndex: { type: Number, default: -1 },
    activeProcessId: { type: String, default: '' },
    formatBindingName: { type: Function, default: binding => binding.name || binding.node_name || binding.id || '未命名动作' }
})
const emit = defineEmits(['update:search', 'update:page', 'preview-binding', 'preview-process'])
function preview(entry) {
    if (entry.process) emit('preview-process', entry.process.id)
    else emit('preview-binding', entry.index)
}
function changePage(value) {
    const next = Number(value)
    if (Number.isInteger(next) && next >= 1 && next <= props.pageCount) emit('update:page', next)
}
</script>
<template>
    <section class="imported-action-list" aria-label="动作节点列表">
        <div class="action-list-heading">动作节点 <span>{{ nodeCount }}</span></div>
        <input :value="search" class="input action-search" aria-label="搜索动作节点" placeholder="搜索动作名称…" @input="emit('update:search', $event.target.value)" />
        <div class="action-cards">
            <article v-for="entry in entries" :key="entry.process ? `process_${entry.process.id}` : entry.binding.id" class="action-card" :class="{ active: entry.process ? activeProcessId === entry.process.id : !activeProcessId && activeBindingIndex === entry.index }">
                <button type="button" class="action-select" @click="preview(entry)">
                    <strong>{{ entry.process ? entry.process.label : formatBindingName(entry.binding) }}</strong>
                    <small>{{ entry.process?.detail || '已有部件动作' }} · 点击预览</small>
                </button>
                <button type="button" class="preview-button" :aria-label="`预览${entry.process ? entry.process.label : formatBindingName(entry.binding)}`" @click="preview(entry)">预览</button>
            </article>
            <p v-if="!entries.length" class="action-empty" role="status">{{ search ? '没有匹配的动作' : '暂无动作，请导入动作包' }}</p>
        </div>
        <nav class="action-pagination" aria-label="动作节点分页">
            <span aria-live="polite">{{ total }} 项 · 第 {{ page }} / {{ pageCount }} 页</span>
            <div>
                <button type="button" :disabled="page <= 1" aria-label="上一页动作节点" @click="changePage(page - 1)">上一页</button>
                <select :value="page" aria-label="跳转动作节点页码" @change="changePage($event.target.value)"><option v-for="number in pageCount" :key="number" :value="number">{{ number }}</option></select>
                <button type="button" :disabled="page >= pageCount" aria-label="下一页动作节点" @click="changePage(page + 1)">下一页</button>
            </div>
        </nav>
    </section>
</template>
<style scoped>
.imported-action-list{display:flex;flex:1;flex-direction:column;min-height:0;gap:12px;color:#34455d;font-size:calc(12px * var(--admin-font-scale,1))}
.action-list-heading{padding:11px 12px;border:1px solid #e5ebf6;border-radius:8px;background:#f5f8fd;color:#2463dd;font-weight:600}.action-list-heading span{margin-left:5px;color:#8494ac}
.action-search{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #d6deeb;border-radius:8px;font:inherit}
.action-cards{display:flex;flex:1;min-height:160px;overflow:auto;flex-direction:column;gap:10px}.action-card{display:flex;align-items:center;gap:8px;border:1px solid #e1e8f3;border-radius:9px;padding:10px}.action-card.active{border-color:#9abaff;background:#f4f8ff}
.action-select{display:grid;gap:7px;flex:1;min-width:0;border:0;background:none;text-align:left;color:inherit;cursor:pointer}.action-select strong{overflow-wrap:anywhere}.action-select small{color:#8492a9;font-size:11px}
.preview-button,.action-pagination button,.action-pagination select{padding:6px 9px;border:1px solid #d8e0ec;border-radius:6px;background:white;color:#47638b;font:inherit;cursor:pointer}.action-pagination button:disabled{color:#a4adbd;background:#f7f9fc;cursor:default}
.action-empty{margin:auto;text-align:center;color:#8a99b1;line-height:1.8}.action-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid #e8edf5;padding-top:10px;color:#8492aa;font-size:11px}.action-pagination>div{display:flex;gap:5px;align-items:center}
@media(max-width:520px){.action-pagination{flex-wrap:wrap}.action-pagination>div{margin-left:auto}}
</style>
