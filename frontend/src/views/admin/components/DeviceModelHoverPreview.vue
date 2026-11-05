<script setup>
import { onMounted, onUnmounted, onDeactivated, ref } from 'vue'
import { previewModelForDevice, modelHoverSnapshot } from '../../../runtime/modelHoverSnapshot.js'
const props = defineProps({ models: { type: Array, default: () => [] } })
const visible = ref(false), image = ref(''), name = ref(''), failed = ref(false), position = ref({})
let showTimer, hideTimer, abort, generation = 0
function close() {
  clearTimeout(showTimer); clearTimeout(hideTimer); ++generation
  abort?.abort(); abort = null; visible.value = false; image.value = ''
}
function keep() { clearTimeout(hideTimer) }
function hide() { clearTimeout(showTimer); hideTimer = setTimeout(close, 100) }
function show(device, anchor) {
  close()
  const current = generation, source = previewModelForDevice(device, props.models)
  source.type = device.model_type
  showTimer = setTimeout(async () => {
    if (!anchor?.isConnected || current !== generation) return
    const box = anchor.getBoundingClientRect(), width = Math.min(280, innerWidth - 16)
    const height = width / 1.4 + 46
    let left = box.right + 10
    if (left + width > innerWidth - 8) left = box.left - width - 10
    position.value = { width: `${width}px`, left: `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`,
      top: `${Math.max(8, Math.min(box.top - 15, innerHeight - height - 8))}px` }
    visible.value = true; name.value = source.name; failed.value = false
    abort = new AbortController()
    try { const result = await modelHoverSnapshot(source, abort.signal); if (current === generation) image.value = result }
    catch (error) { if (current === generation && error.name !== 'AbortError') failed.value = true }
  }, 180)
}
function key(event) { if (event.key === 'Escape') close() }
function scroll(event) { if (!event.target?.closest?.('.device-model-hover')) close() }
onMounted(() => { window.addEventListener('scroll', scroll, true); window.addEventListener('resize', close); window.addEventListener('keydown', key) })
onDeactivated(close)
onUnmounted(() => { close(); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key) })
defineExpose({ show, hide, close })
</script>

<template>
  <Teleport to="body">
    <aside v-if="visible" class="device-model-hover" data-testid="device-model-hover" role="tooltip" :aria-label="`${name} 模型预览`"
      :style="position" @mouseenter="keep" @mouseleave="hide">
      <div class="model-hover-picture">
        <img v-if="image" :src="image" :alt="`${name} 模型外观`" />
        <span v-else role="status">{{ failed ? '预览暂不可用' : '加载模型…' }}</span>
      </div>
      <strong :title="name">{{ name }}</strong>
    </aside>
  </Teleport>
</template>

<style scoped>
.device-model-hover { position: fixed; z-index: 12000; box-sizing: border-box; padding: 7px; border: 1px solid #dce4ef; border-radius: 12px; background: #fff; box-shadow: 0 12px 38px #172f5228; color: #27384e; }
.model-hover-picture { display: grid; place-items: center; aspect-ratio: 1.4; background: #edf2f7; border-radius: 7px; overflow: hidden; color: #728398; font-size: 13px; }
.model-hover-picture img { display: block; width: 100%; height: 100%; object-fit: contain; }
.device-model-hover strong { display: block; margin: 7px 5px 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
</style>
