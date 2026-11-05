<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
const props = defineProps({ show: Boolean, loading: { type: Object, default: null } })
const visible = ref(false)
let timer
watch(() => props.show, show => {
  clearTimeout(timer)
  if (!show) { visible.value = false; return }
  timer = setTimeout(() => { visible.value = true }, 150)
}, { immediate: true })
onUnmounted(() => clearTimeout(timer))
const progress = computed(() => typeof props.loading?.progress === 'number' && Number.isFinite(props.loading.progress)
  ? Math.max(0, Math.min(1, props.loading.progress)) : null)
const circumference = 2 * Math.PI * 24
const indeterminate = computed(() => progress.value === null || progress.value === 0)
const caption = computed(() => props.loading?.stage === 'models' && props.loading.total > 0
  ? `模型 ${props.loading.completed} / ${props.loading.total}`
  : props.loading?.stage === 'retry' ? '连接恢复中' : props.loading?.stage === 'environment' ? '正在加载厂房' : '正在准备场景')
</script>
<template>
  <Transition name="scene-loading"><div v-if="visible" class="scene-loading-layer" aria-live="polite" role="status">
    <div class="scene-loading-card">
      <svg class="scene-loading-ring" :class="{ 'is-indeterminate': indeterminate }" viewBox="0 0 64 64" role="progressbar" aria-label="三维场景加载" :aria-valuenow="indeterminate ? undefined : Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
        <circle class="scene-loading-track" cx="32" cy="32" r="24"/>
        <circle class="scene-loading-arc" cx="32" cy="32" r="24" :stroke-dasharray="circumference" :stroke-dashoffset="circumference * (1 - (indeterminate ? .74 : progress))"/>
      </svg>
      <span>{{ caption }}</span>
      <small v-if="loading?.stage === 'models' && loading.modelName" :title="loading.modelName">{{ loading.modelName }}</small>
    </div>
  </div></Transition>
</template>
<style scoped>
.scene-loading-layer{position:absolute;inset:0;z-index:70;display:grid;place-items:center;pointer-events:none;background:#11101b17}.scene-loading-card{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:10px;min-width:144px;max-width:min(270px,calc(100% - 32px));padding:22px 24px 20px;border:1px solid #e9e2f2d9;border-radius:18px;background:#f7f3fbeF;color:#70588e;box-shadow:0 12px 48px #0f092526;backdrop-filter:blur(16px)}.scene-loading-ring{width:64px;height:64px;fill:none;stroke-width:5;transform:rotate(-90deg)}.scene-loading-track{stroke:#e7e0ee}.scene-loading-arc{stroke:#7055af;stroke-linecap:butt;transition:stroke-dashoffset .18s ease}.scene-loading-card>span{font-size:12px;line-height:1.5}.scene-loading-card>small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#9986ae}.scene-loading-ring.is-indeterminate{animation:scene-ring-turn 1s linear infinite}.scene-loading-enter-active,.scene-loading-leave-active{transition:opacity .12s}.scene-loading-enter-from,.scene-loading-leave-to{opacity:0}@keyframes scene-ring-turn{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}@media(prefers-reduced-motion:reduce){.scene-loading-ring.is-indeterminate{animation:none}.scene-loading-arc,.scene-loading-enter-active,.scene-loading-leave-active{transition:none}}
</style>
