<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { copyTextToClipboard } from '../utils/clipboard.js'

const props = defineProps({ path: { type: String, default: '' } })
const available = computed(() => Boolean(props.path?.trim()))
const copying = ref(false)
const feedback = ref('')
const failed = ref(false)
let feedbackTimer
let disposed = false

function clearFeedback() {
    clearTimeout(feedbackTimer)
    feedback.value = ''
    failed.value = false
}

async function copyPath() {
    if (!available.value || copying.value) return
    const path = props.path
    clearFeedback()
    copying.value = true
    try {
        await copyTextToClipboard(path)
        if (!disposed && path === props.path) feedback.value = '✓ 已复制'
    } catch {
        if (!disposed && path === props.path) {
            failed.value = true
            feedback.value = '复制失败，请手动复制'
        }
    } finally {
        copying.value = false
        if (!disposed && feedback.value) feedbackTimer = setTimeout(clearFeedback, 3000)
    }
}

watch(() => props.path, clearFeedback)
onBeforeUnmount(() => { disposed = true; clearTimeout(feedbackTimer) })
</script>

<template>
    <button
        v-if="available"
        type="button"
        class="copy-path-button"
        :class="{ 'copy-path-failed': failed }"
        :title="`${path}（单击复制完整路径）`"
        :aria-label="`复制文件路径：${path}`"
        :disabled="copying"
        @click.stop="copyPath"
        @keydown.stop
    >
        <span class="copy-path-text">{{ path }}</span>
        <span v-if="feedback" class="copy-path-feedback" role="status" aria-live="polite">{{ feedback }}</span>
    </button>
    <span v-else class="copy-path-empty">—</span>
</template>

<style scoped>
.copy-path-button { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 2px 0; color: inherit; background: transparent; border: 0; border-radius: 3px; font: inherit; line-height: inherit; text-align: left; cursor: pointer; }
.copy-path-button:hover:not(:disabled) .copy-path-text { color: #245fd0; text-decoration: underline; text-underline-offset: 3px; }
.copy-path-button:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.copy-path-button:disabled { cursor: progress; }
.copy-path-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; }
.copy-path-feedback { flex: 0 0 auto; color: #21834f; font-size: .9em; }
.copy-path-failed .copy-path-feedback { color: #b42318; }
.copy-path-empty { color: #8e8e93; }
</style>
