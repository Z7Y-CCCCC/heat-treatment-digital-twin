<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import ProjectBundleTransfer from './ProjectBundleTransfer.vue'

const factories = ref([]), loading = ref(true), error = ref('')
let generation = 0
onUnmounted(() => { generation++ })
async function load() {
  const current = ++generation
  loading.value = true; error.value = ''
  try {
    const result = await adminApi.listFactories()
    if (current !== generation) return
    if (result?.error || !Array.isArray(result?.factories)) throw new Error(result?.error || '工厂列表读取失败')
    factories.value = result.factories
  } catch (cause) { if (current === generation) error.value = cause.message || '工厂列表读取失败' }
  finally { if (current === generation) loading.value = false }
}
onMounted(load)
</script>

<template>
  <div class="project-migration-settings" data-testid="project-migration-settings">
    <p v-if="loading && !factories.length" role="status">正在读取工厂…</p>
    <div v-if="error" class="migration-load-error" role="alert">{{ error }} <button type="button" class="btn btn-sm" :disabled="loading" @click="load">重试</button></div>
    <ProjectBundleTransfer :factories="factories" @imported="load" />
  </div>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.project-migration-settings { max-width: 1080px; }
.project-migration-settings > p { margin: 18px 0 0; color: #7b879a; font-size: calc(13px * var(--admin-font-scale, 1)); }
.migration-load-error { display: flex; align-items: center; gap: 12px; margin-top: 18px; color: #b42318; font-size: calc(13px * var(--admin-font-scale, 1)); }
</style>
