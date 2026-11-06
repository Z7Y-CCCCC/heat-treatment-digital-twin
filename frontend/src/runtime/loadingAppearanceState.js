import { shallowRef } from 'vue'
import { adminApi } from '../config/factoryConfig.js'
import { initialLoadingExperience, cacheLoadingExperience } from './loadingExperienceConfig.js'

export const loadingAppearance = shallowRef(initialLoadingExperience())
let revision = 0
let readRequest = 0
export function applyLoadingAppearance(config, notifyHost = false) {
  const next = cacheLoadingExperience(config)
  const changed = JSON.stringify(next) !== JSON.stringify(loadingAppearance.value)
  if (changed) loadingAppearance.value = next
  revision++
  if (notifyHost && changed && typeof window !== 'undefined') window.chrome?.webview?.postMessage({ type: 'loading_appearance_changed' })
  return loadingAppearance.value
}
export async function readLoadingAppearance() {
  const expected = revision
  const request = ++readRequest
  const result = await adminApi.getLoadingExperience()
  if (result.error) throw new Error(result.error)
  if (revision === expected && request === readRequest) applyLoadingAppearance(result.config)
  return loadingAppearance.value
}
export async function patchLoadingAppearance(patch) {
  // Invalidate earlier GETs before awaiting a write; only confirmed saves apply.
  revision++
  const result = await adminApi.patchLoadingExperience(patch)
  if (result.error || !result.success) throw new Error(result.error || '保存外观设置失败')
  return applyLoadingAppearance(result.config, true)
}
