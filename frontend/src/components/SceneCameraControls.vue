<script setup>
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'

const props = defineProps({
  available: { type: Boolean, default: false },
  requestAction: { type: Function, required: true }
})
const emit = defineEmits(['geometry-change'])
const open = ref(false), pending = ref(false), error = ref(''), host = ref(null), trigger = ref(null)
const panelId = `scene-camera-${useId()}`
let disposed = false
const actions = [
  { id: 'zoomIn', label: '拉近', paths: ['M12 5v14M5 12h14'] },
  { id: 'zoomOut', label: '拉远', paths: ['M5 12h14'] },
  { id: 'rotateLeft', label: '向左旋转', paths: ['M4 10a8 8 0 1 1 1 8', 'M4 4v6h6'] },
  { id: 'rotateRight', label: '向右旋转', paths: ['M20 10a8 8 0 1 0-1 8', 'M20 4v6h-6'] }
]
function close(restoreFocus = false) { open.value = false; if (restoreFocus) trigger.value?.focus() }
function toggle() { error.value = ''; open.value = !open.value }
function outside(event) { if (open.value && !host.value?.contains(event.target)) close() }
function escape(event) {
  if (!open.value || event.key !== 'Escape') return
  // Closing this local panel must not also navigate back out of a device.
  event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); close(true)
}
async function run(action) {
  if (disposed || !props.available || pending.value || ![...actions.map(item => item.id), 'fit'].includes(action)) return false
  pending.value = true; error.value = ''
  try {
    if (await props.requestAction(action) === false) throw new Error('视角操作未执行，请重试')
    return true
  } catch (failure) {
    if (!disposed) error.value = failure.message || '视角调整失败，请重试'
    return false
  } finally { if (!disposed) pending.value = false }
}
watch([open, error], async () => { await nextTick(); if (!disposed) emit('geometry-change') })
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside)
  window.addEventListener('keydown', escape, true)
})
onUnmounted(() => {
  disposed = true
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('focusin', outside)
  window.removeEventListener('keydown', escape, true)
})
</script>

<template>
  <div ref="host" class="scene-camera-controls" @pointerdown.stop @dblclick.stop>
    <Transition name="camera-panel">
      <section v-if="open" :id="panelId" class="scene-camera-panel" role="group" aria-label="视角调整" data-overlay-hit="true" :aria-busy="pending">
        <header><strong>视角调整</strong><button type="button" aria-label="关闭视角调整" title="收起" @click="close(true)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></button></header>
        <div class="scene-camera-actions">
          <button v-for="action in actions" :key="action.id" type="button" :aria-label="action.label" :title="action.label" :disabled="!available" :aria-disabled="pending || !available" @click="run(action.id)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="path in action.paths" :key="path" :d="path"/></svg><span>{{ action.label }}</span>
          </button>
        </div>
        <button type="button" class="scene-camera-fit" :disabled="!available" :aria-disabled="pending || !available" title="恢复当前工厂、车间、产线或设备的视角" @click="run('fit')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z"/></svg><span>恢复视角</span></button>
        <p v-if="error" class="scene-camera-error" role="alert">{{ error }}</p>
        <p class="scene-camera-hint" role="status">{{ !available ? '等待场景就绪或连接恢复' : pending ? '正在调整…' : '左键点击即可 · 无需滚轮' }}</p>
      </section>
    </Transition>
    <button ref="trigger" type="button" class="scene-camera-trigger" :class="{ 'is-open': open }" aria-label="调整视角（无需滚轮）" title="视角调整 · 无需鼠标滚轮" :aria-expanded="open" :aria-controls="panelId" data-overlay-hit="true" @click="toggle">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1.5 3H20a1 1 0 0 1 1 1v11H3V8a1 1 0 0 1 1-1h3.5L9 4Z"/><circle cx="12" cy="12.5" r="3.5"/></svg>
    </button>
  </div>
</template>

<style scoped>
.scene-camera-controls{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:max(20px,env(safe-area-inset-bottom));z-index:1040;pointer-events:none;color:#d9e5f5;font-family:"Inter","Microsoft YaHei UI",sans-serif}
.scene-camera-trigger{display:grid;place-items:center;width:40px;height:40px;padding:0;border:1px solid #9db4dc47;border-radius:12px;background:linear-gradient(145deg,#29384be8,#172333e8);box-shadow:0 4px 14px #08111f30,inset 0 1px 0 #d7e8ff0d;color:#d3e4fa;cursor:pointer;pointer-events:auto;backdrop-filter:blur(14px);transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}
.scene-camera-trigger:hover,.scene-camera-trigger.is-open{border-color:#a7c5f69c;background:linear-gradient(145deg,#345078f0,#223953f0);box-shadow:0 4px 16px #08111f40}
.scene-camera-trigger svg{width:21px;height:21px}.scene-camera-controls svg{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.scene-camera-panel{position:absolute;right:0;bottom:51px;box-sizing:border-box;width:212px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 100px);overflow-y:auto;padding:12px;border:1px solid #9db4dc40;border-radius:14px;background:linear-gradient(145deg,#243247f5,#172333f5);box-shadow:0 12px 32px #030b1840,inset 0 1px 0 #d7e8ff0a;backdrop-filter:blur(16px);pointer-events:auto;transform-origin:bottom right}
.scene-camera-panel header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;padding-left:2px}.scene-camera-panel header strong{font-size:12px;font-weight:600;letter-spacing:.04em}.scene-camera-panel header button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:#8fa4be;cursor:pointer}.scene-camera-panel header button:hover{background:#c4d9ff12;color:#e5efff}.scene-camera-panel header svg{width:15px;height:15px}
.scene-camera-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.scene-camera-actions button,.scene-camera-fit{display:flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;min-height:43px;padding:8px 5px;border:1px solid #9db4dc29;border-radius:8px;background:#b4cefa0a;color:#d0ddf0;font:inherit;font-size:11px;cursor:pointer;transition:background .15s ease,border-color .15s ease}.scene-camera-actions button:hover:not(:disabled),.scene-camera-fit:hover:not(:disabled){border-color:#93b8ef73;background:#82aff129;color:#f0f6ff}.scene-camera-actions button:active:not(:disabled),.scene-camera-fit:active:not(:disabled){background:#82aff142}.scene-camera-actions svg,.scene-camera-fit svg{width:17px;height:17px}
.scene-camera-fit{width:100%;margin-top:8px;border-color:#91b8ee47;background:#83b1f21a;color:#bfd8fb}.scene-camera-controls button:disabled{opacity:.4;cursor:not-allowed}.scene-camera-controls button[aria-disabled=true]:not(:disabled){cursor:wait}.scene-camera-controls button:focus-visible{outline:2px solid #9cc7ff;outline-offset:2px}
.scene-camera-hint{margin:11px 0 1px;color:#8297b2;text-align:center;font-size:10px;line-height:1.5}.scene-camera-error{margin:9px 0 0;padding:7px;border-radius:6px;background:#ff889311;color:#f0aab5;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.camera-panel-enter-active,.camera-panel-leave-active{transition:opacity .14s ease,transform .14s ease}.camera-panel-enter-from,.camera-panel-leave-to{opacity:0;transform:translateY(5px) scale(.97)}
@media(prefers-reduced-motion:reduce){.scene-camera-trigger,.scene-camera-actions button,.scene-camera-fit,.camera-panel-enter-active,.camera-panel-leave-active{transition:none}}
</style>
