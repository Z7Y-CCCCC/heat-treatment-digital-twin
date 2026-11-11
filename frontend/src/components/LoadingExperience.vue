<script setup>
import { computed, onUnmounted, ref } from 'vue'
import { initialLoadingExperience } from '../runtime/loadingExperienceConfig.js'
import { loadingPhaseState } from '../../../shared/loadingPhaseProgress.mjs'

const props = defineProps({
  show: { type: Boolean, default: true },
  progress: { type: Number, default: 8 },
  phase: { type: Number, default: 0 },
  step: { type: String, default: '正在读取现场配置' },
  config: { type: [Object, String], default: null }
})
const appearance = computed(() => initialLoadingExperience(props.config))

const phases = [
  { label: '现场配置', caption: 'CONFIGURATION' },
  { label: '三维场景', caption: '3D SCENE' },
  { label: '设备模型', caption: 'EQUIPMENT' },
  { label: '实时数据', caption: 'LIVE DATA' }
]
const percentage = computed(() => { const n=Number(props.progress); return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):0 })
const phaseStates = computed(() => phases.map((_,index)=>loadingPhaseState(props.progress,props.phase,index)))

const modelTiltX = ref(0)
const modelTiltY = ref(0)
const modelScale = ref(1)
const modelDragging = ref(false)
const lampStates = ref([true, true, true, true, true, true])
const smokeStates = ref([true, true])
const furnaceStates = ref([true, true])
const loadingLamps = [
  { label: '入口状态灯', x: '5.6%', y: '53.2%', tone: 'cyan' },
  { label: '输送线状态灯', x: '18.7%', y: '65%', tone: 'cyan' },
  { label: '热处理设备状态灯', x: '44.6%', y: '56.8%', tone: 'cyan' },
  { label: '中段设备状态灯', x: '61.6%', y: '53.9%', tone: 'cyan' },
  { label: '炉体指示灯', x: '76.8%', y: '48.9%', tone: 'amber' },
  { label: '末端设备状态灯', x: '87.8%', y: '42.2%', tone: 'amber' }
]
const loadingSmokeStacks = [
  { label: '前段排气烟囱', x: '26%', y: '47.6%' },
  { label: '主排气烟囱', x: '60.5%', y: '37%' }
]
const loadingFurnaces = [
  { label: '入口加热炉', x: '27.3%', y: '71.3%' },
  { label: '主加热炉', x: '71.6%', y: '49.4%' }
]
let modelPointer = null
let poseFrame = 0
let pendingTiltX = 0
let pendingTiltY = 0
const modelStyle = computed(() => ({
  '--model-tilt-x': `${modelTiltX.value}deg`,
  '--model-tilt-y': `${modelTiltY.value}deg`,
  '--model-scale': modelScale.value
}))

function onModelPointerDown(event) {
  if (event.button !== 0) return
  modelPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
  pendingTiltX = modelTiltX.value
  pendingTiltY = modelTiltY.value
  modelDragging.value = true
  event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onModelPointerMove(event) {
  if (!modelPointer || modelPointer.id !== event.pointerId) return
  const dx = event.clientX - modelPointer.x
  const dy = event.clientY - modelPointer.y
  modelPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
  pendingTiltY = Math.max(-42, Math.min(42, pendingTiltY + dx * 0.34))
  pendingTiltX = Math.max(-22, Math.min(22, pendingTiltX - dy * 0.25))
  if (!poseFrame) poseFrame = requestAnimationFrame(() => {
    poseFrame = 0
    modelTiltX.value = pendingTiltX
    modelTiltY.value = pendingTiltY
  })
}

function stopModelDrag() {
  modelPointer = null
  modelDragging.value = false
}

function onModelWheel(event) {
  event.preventDefault()
  modelScale.value = Math.max(0.88, Math.min(1.22, modelScale.value - Math.sign(event.deltaY) * 0.06))
}

function resetModelView() {
  cancelAnimationFrame(poseFrame)
  poseFrame = 0
  pendingTiltX = pendingTiltY = 0
  modelTiltX.value = 0
  modelTiltY.value = 0
  modelScale.value = 1
}
onUnmounted(() => { cancelAnimationFrame(poseFrame); modelPointer = null })
</script>

<template>
  <Transition name="loading-experience">
    <section v-if="show" class="loading-experience" :class="{dark:appearance.theme==='dark',quiet:appearance.preset==='quiet','custom-artwork':!!appearance.imageUrl}" :style="{'--loading-background':appearance.background,'--loading-accent':appearance.accent}" role="status" aria-live="polite" aria-label="大屏正在加载">
      <div class="loading-atmosphere" aria-hidden="true"></div>
      <div class="loading-card">
        <header class="loading-heading">
          <span class="loading-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="loading-kicker">{{ appearance.kicker }}</span>
          <span class="loading-live"><i></i> SYSTEM STARTUP</span>
        </header>

        <div class="loading-artwork">
          <div class="loading-art-glow" aria-hidden="true"></div>
          <div
            class="loading-model"
            :class="{ dragging: modelDragging }"
            :style="modelStyle"
            aria-label="拖动旋转厂房示意图，滚轮缩放，双击复位"
            @pointerdown="onModelPointerDown"
            @pointermove="onModelPointerMove"
            @pointerup="stopModelDrag"
            @pointercancel="stopModelDrag"
            @lostpointercapture="stopModelDrag"
            @wheel="onModelWheel"
            @dblclick.prevent="resetModelView"
          >
            <div class="loading-model-stage">
              <img :src="appearance.imageUrl || '/loading/industrial-factory.png'" alt="热处理生产现场三维示意图" draggable="false" />
              <span
                v-for="(stack, index) in loadingSmokeStacks"
                :key="stack.label"
                class="loading-smoke"
                :class="{ off: !smokeStates[index] }"
                :style="{ left: stack.x, top: stack.y }"
                aria-hidden="true"
              ></span>
              <button
                v-for="(lamp, index) in loadingLamps"
                :key="lamp.label"
                type="button"
                class="loading-hotspot lamp"
                :class="[lamp.tone, { off: !lampStates[index] }]"
                :style="{ left: lamp.x, top: lamp.y }"
                :aria-label="`${lamp.label}：${lampStates[index] ? '关闭' : '点亮'}`"
                :aria-pressed="lampStates[index]"
                :title="`${lamp.label} · 点击${lampStates[index] ? '关闭' : '点亮'}`"
                @pointerdown.stop
                @click.stop="lampStates[index] = !lampStates[index]"
                @dblclick.stop
              ><i></i></button>
              <button
                v-for="(stack, index) in loadingSmokeStacks"
                :key="stack.label"
                type="button"
                class="loading-hotspot stack-control"
                :style="{ left: stack.x, top: stack.y }"
                :aria-label="`${stack.label}：${smokeStates[index] ? '停止排烟' : '启动排烟'}`"
                :aria-pressed="smokeStates[index]"
                :title="`${stack.label} · 点击${smokeStates[index] ? '停止' : '启动'}排烟`"
                @pointerdown.stop
                @click.stop="smokeStates[index] = !smokeStates[index]"
                @dblclick.stop
              ><i></i></button>
              <button
                v-for="(furnace, index) in loadingFurnaces"
                :key="furnace.label"
                type="button"
                class="loading-hotspot furnace-control"
                :class="{ off: !furnaceStates[index] }"
                :style="{ left: furnace.x, top: furnace.y }"
                :aria-label="`${furnace.label}：${furnaceStates[index] ? '关闭炉火' : '点燃炉火'}`"
                :aria-pressed="furnaceStates[index]"
                :title="`${furnace.label} · 点击${furnaceStates[index] ? '关闭' : '点燃'}炉火`"
                @pointerdown.stop
                @click.stop="furnaceStates[index] = !furnaceStates[index]"
                @dblclick.stop
              ><i></i></button>
            </div>
          </div>
          <span class="loading-art-caption"><i></i> FACTORY SYSTEMS <b>INITIALIZING</b></span>
          <span class="loading-art-index" aria-hidden="true">拖动旋转 · 滚轮缩放 · 双击复位</span>
        </div>

        <div class="loading-status-row">
          <div>
            <h1>{{ appearance.title }}</h1>
            <p>{{ step }}</p>
          </div>
          <strong class="loading-percent">{{ percentage }}<small>%</small></strong>
        </div>

        <div class="loading-progress-track" role="progressbar" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100">
          <i :style="{ transform: `scaleX(${percentage / 100})` }"></i>
        </div>

        <ol class="loading-phases" aria-hidden="true">
          <li v-for="(item, index) in phases" :key="item.caption" :class="{ complete: phaseStates[index].complete, current: phaseStates[index].current }">
            <span class="loading-phase-marker">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle class="phase-ring-track" cx="12" cy="12" r="10" />
                <circle class="phase-ring-value" cx="12" cy="12" r="10" pathLength="100" :stroke-dasharray="`${phaseStates[index].progress*100} 100`" transform="rotate(-90 12 12)" />
                <path v-if="phaseStates[index].complete" class="phase-ring-check" d="m7.5 12 3 3 6-6" />
              </svg>
            </span>
            <span class="loading-phase-copy"><strong>{{ item.label }}</strong><small>{{ item.caption }}</small></span>
          </li>
        </ol>
      </div>
      <footer class="loading-footer"><span>PRODUCTION OPERATIONS</span><i></i><span>请稍候，正在同步现场状态</span></footer>
    </section>
  </Transition>
</template>

<style scoped>
.loading-experience{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;overflow:hidden;padding:30px;background:var(--loading-background,#f5f7fb);color:#1d2939;font-family:Inter,"Noto Sans SC","Segoe UI","Microsoft YaHei UI",sans-serif;font-synthesis:none;-webkit-font-smoothing:antialiased}
.loading-atmosphere{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 38%,rgba(87,139,247,.06),transparent 52%),linear-gradient(135deg,#f8fbff,transparent 48%,#eef3fc);pointer-events:none}
.loading-card{position:relative;width:min(900px,92vw);padding:27px 34px 24px;border:1px solid #dbe4f2;border-radius:13px;background:#ffffff;box-shadow:0 12px 36px rgba(42,72,125,.07)}
.loading-heading{display:flex;align-items:center;gap:11px;color:#54709a}.loading-mark{position:relative;display:flex;align-items:flex-end;gap:3px;width:18px;height:18px;padding:3px;border:1px solid #d3e0f7;border-radius:5px}.loading-mark i{width:3px;border-radius:2px;background:#2563eb}.loading-mark i:nth-child(1){height:5px}.loading-mark i:nth-child(2){height:9px}.loading-mark i:nth-child(3){height:7px;background:#76a2ff}.loading-kicker{font-size:9px;font-weight:600;letter-spacing:.17em}.loading-kicker i{padding:0 5px;color:#98a7bf;font-style:normal}.loading-live{display:flex;align-items:center;gap:7px;margin-left:auto;color:#71819b;font-size:8px;letter-spacing:.12em}.loading-live i,.loading-art-caption i{width:5px;height:5px;border-radius:50%;background:#2563eb;box-shadow:none;animation:loading-pulse 1.8s ease-in-out infinite}
.loading-artwork{position:relative;display:grid;place-items:center;height:clamp(190px,30vw,310px);margin:12px 0 4px;overflow:hidden;border-bottom:1px solid #edf1f8}.loading-artwork::before{position:absolute;inset:0;z-index:1;content:"";background:linear-gradient(90deg,rgba(255,255,255,.7),transparent 24%,transparent 76%,rgba(255,255,255,.7)),linear-gradient(0deg,#f5f7fb 0%,transparent 23%,transparent 84%,rgba(255,255,255,.4));pointer-events:none}.loading-art-glow{position:absolute;bottom:13%;width:52%;height:13%;border-radius:50%;background:radial-gradient(ellipse,rgba(93,139,222,.12),transparent 70%)}.loading-model{position:relative;z-index:2;display:grid;place-items:center;width:min(77%,720px);height:100%;touch-action:none;user-select:none;cursor:grab;transform:perspective(950px) rotateX(var(--model-tilt-x,0deg)) rotateY(var(--model-tilt-y,0deg)) scale(var(--model-scale,1));transform-style:preserve-3d;transition:transform .22s cubic-bezier(.2,.75,.25,1);will-change:transform}.loading-model.dragging{cursor:grabbing;transition:none}.loading-model-stage{position:relative;width:auto;height:100%;max-width:100%;aspect-ratio:3/2;animation:loading-float 5s ease-in-out infinite}.loading-model-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}.loading-hotspot{position:absolute;z-index:2;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;transform:translate(-50%,-50%);cursor:pointer}.loading-hotspot:focus-visible{outline:1px solid rgba(255,255,255,.85);outline-offset:1px}.loading-hotspot i{position:relative;z-index:1;display:block;width:7px;height:7px;border:1px solid rgba(255,255,255,.72);border-radius:50%;background:#81e5d5;box-shadow:0 0 8px 3px rgba(70,220,202,.65);animation:loading-lamp-breathe 2.4s ease-in-out infinite}.loading-hotspot.lamp.amber i{background:#ffd18d;box-shadow:0 0 8px 3px rgba(255,161,58,.65);animation-delay:.7s}.loading-hotspot.lamp.off::before,.loading-hotspot.furnace-control.off::before{position:absolute;z-index:0;border-radius:50%;background:radial-gradient(circle,rgba(42,44,45,.94) 0%,rgba(42,44,45,.78) 60%,rgba(42,44,45,0) 100%);content:""}.loading-hotspot.lamp.off::before{width:12px;height:12px}.loading-hotspot.furnace-control.off::before{width:27px;height:24px}.loading-hotspot.lamp.off i{opacity:.16;box-shadow:none;animation:none}.loading-hotspot.stack-control i{width:8px;height:8px;border:1px solid rgba(226,236,235,.6);background:rgba(218,227,227,.45);box-shadow:0 0 8px rgba(190,210,210,.4)}.loading-hotspot.furnace-control i{width:10px;height:10px;border:1px solid rgba(255,208,143,.7);background:rgba(255,163,64,.85);box-shadow:0 0 12px 5px rgba(255,144,44,.4);animation:loading-fire-breathe 1.8s ease-in-out infinite}.loading-hotspot.furnace-control.off i{opacity:.12;box-shadow:none;animation:none}.loading-smoke{position:absolute;z-index:1;width:10px;height:18px;pointer-events:none;transform:translate(-50%,-100%);transition:opacity .25s ease}.loading-smoke::before,.loading-smoke::after{position:absolute;bottom:0;left:50%;width:6px;height:9px;border-radius:50%;background:rgba(220,226,225,.42);filter:blur(2px);content:"";animation:loading-smoke-rise 2.8s ease-out infinite}.loading-smoke::after{animation-delay:1.4s}.loading-smoke.off{opacity:0}.loading-art-caption,.loading-art-index{position:absolute;z-index:2;bottom:13px;color:#71819b;font-size:8px;letter-spacing:.12em;pointer-events:none}.loading-art-caption{left:1px;display:flex;align-items:center;gap:8px}.loading-art-caption b{color:#54709a;font-weight:500}.loading-art-index{right:1px;color:#71819b;font-size:7px}
.loading-status-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 1px 13px}.loading-status-row h1{margin:0;color:#1d2939;font-size:17px;font-weight:500;letter-spacing:.025em}.loading-status-row p{margin:6px 0 0;color:#667085;font-size:11px}.loading-percent{color:#2563eb;font-size:22px;font-weight:400;font-variant-numeric:tabular-nums}.loading-percent small{margin-left:2px;color:#71819b;font-size:10px}
.loading-progress-track{position:relative;height:3px;overflow:hidden;border-radius:99px;background:#e5edfb}.loading-progress-track i{position:absolute;inset:0;border-radius:inherit;background:var(--loading-accent,#2563eb);transform-origin:left;transition:transform .18s ease-out}
.loading-phases{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 0;padding:0;list-style:none}.loading-phases li{display:flex;align-items:center;gap:9px;min-width:0;color:#98a7bf}.loading-phase-marker{display:grid;place-items:center;width:19px;height:19px;flex:0 0 19px;border:1px solid #dbe4f2;border-radius:50%}.loading-phase-marker i{width:4px;height:4px;border-radius:50%;background:#98a7bf}.loading-phase-copy{display:grid;gap:3px;min-width:0}.loading-phase-copy strong{overflow:hidden;color:#71819b;font-size:9px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.loading-phase-copy small{overflow:hidden;color:#71819b;font-size:7px;letter-spacing:.08em;text-overflow:ellipsis;white-space:nowrap}.loading-phases li.complete .loading-phase-marker{border-color:#b9cef7;background:#edf3ff}.loading-phases li.complete .loading-phase-marker i,.loading-phases li.current .loading-phase-marker i{background:#2563eb}.loading-phases li.complete .loading-phase-copy strong{color:#315b9f}.loading-phases li.current .loading-phase-marker{border-color:#2563eb;box-shadow:none}.loading-phases li.current .loading-phase-marker i{background:#2563eb;box-shadow:none}.loading-phases li.current .loading-phase-copy strong{color:#2563eb}
.loading-footer{position:absolute;bottom:23px;left:50%;display:flex;align-items:center;gap:10px;transform:translateX(-50%);color:#71819b;font-size:8px;letter-spacing:.06em;white-space:nowrap}.loading-footer i{width:2px;height:2px;border-radius:50%;background:#9dbaf3}
.loading-experience-enter-active,.loading-experience-leave-active{transition:opacity .18s ease}.loading-experience-enter-from,.loading-experience-leave-to{opacity:0}
.loading-experience .loading-experience.quiet .loading-hotspot,.loading-experience.quiet .loading-smoke,.loading-experience.custom-artwork .loading-hotspot,.loading-experience.custom-artwork .loading-smoke{display:none}.loading-experience.quiet .loading-model-stage{animation:none}.loading-experience.quiet .loading-art-index{display:none}
@keyframes loading-float{0%,100%{transform:translateY(2px)}50%{transform:translateY(-5px)}}@keyframes loading-pulse{50%{opacity:.42}}@keyframes loading-lamp-breathe{0%,100%{opacity:.62;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}@keyframes loading-fire-breathe{0%,100%{opacity:.75;transform:scale(.8)}45%{opacity:1;transform:scale(1.25)}}@keyframes loading-smoke-rise{0%{opacity:0;transform:translate(-50%,3px) scale(.45)}22%{opacity:.7}100%{opacity:0;transform:translate(30%,-36px) scale(1.9)}}
@media(max-width:640px){.loading-experience{padding:14px}.loading-card{width:100%;padding:20px 18px 18px}.loading-artwork{height:clamp(160px,45vw,235px)}.loading-phases{gap:5px}.loading-phases li{gap:5px}.loading-phase-marker{width:15px;height:15px;flex-basis:15px}.loading-phase-copy strong{font-size:8px}.loading-phase-copy small{font-size:6px}.loading-live{font-size:7px}.loading-footer{bottom:10px;font-size:7px}}
@media(prefers-reduced-motion:reduce){.loading-model-stage,.loading-live i,.loading-hotspot i,.loading-smoke::before,.loading-smoke::after{animation:none}.loading-experience-enter-active,.loading-experience-leave-active,.loading-progress-track i{transition:none}}
.loading-experience.dark{background:var(--loading-background,#28282b);color:#e8e8e4}
.loading-experience.dark .loading-atmosphere{background:radial-gradient(ellipse at 50% 38%,rgba(166,169,156,.1),transparent 52%),linear-gradient(135deg,rgba(255,255,255,.018),transparent 48%,rgba(0,0,0,.11))}
.loading-experience.dark .loading-card{border:1px solid rgba(206,207,195,.13);background:linear-gradient(145deg,rgba(49,49,52,.97),rgba(38,38,41,.98))}
.loading-experience.dark .loading-heading{color:#b8b9b2}
.loading-experience.dark .loading-mark{border:1px solid rgba(204,209,195,.28)}
.loading-experience.dark .loading-mark i{background:#a9c3b5}
.loading-experience.dark .loading-mark i:nth-child(3){background:#d2a66c}
.loading-experience.dark .loading-kicker i{color:#777871}
.loading-experience.dark .loading-live{color:#92938d}
.loading-experience.dark .loading-live i,.loading-experience.dark .loading-art-caption i{background:#91b4a3}
.loading-experience.dark .loading-artwork::before{background:linear-gradient(90deg,rgba(39,39,42,.68),transparent 24%,transparent 76%,rgba(39,39,42,.68)),linear-gradient(0deg,#29292c 0%,transparent 23%,transparent 84%,rgba(41,41,44,.4))}
.loading-experience.dark .loading-art-glow{background:rgba(200,202,185,.12)}
.loading-experience.dark .loading-hotspot{border:0;background:transparent}
.loading-experience.dark .loading-hotspot:focus-visible{outline:1px solid rgba(255,255,255,.85)}
.loading-experience.dark .loading-hotspot i{border:1px solid rgba(255,255,255,.72);background:#81e5d5}
.loading-experience.dark .loading-hotspot.lamp.amber i{background:#ffd18d}
.loading-experience.dark .loading-hotspot.lamp.off::before,.loading-experience.dark .loading-hotspot.furnace-control.off::before{background:radial-gradient(circle,rgba(42,44,45,.94) 0%,rgba(42,44,45,.78) 60%,rgba(42,44,45,0) 100%)}
.loading-experience.dark .loading-hotspot.stack-control i{border:1px solid rgba(226,236,235,.6);background:rgba(218,227,227,.45)}
.loading-experience.dark .loading-hotspot.furnace-control i{border:1px solid rgba(255,208,143,.7);background:rgba(255,163,64,.85)}
.loading-experience.dark .loading-smoke::before,.loading-experience.dark .loading-smoke::after{background:rgba(220,226,225,.42)}
.loading-experience.dark .loading-art-caption,.loading-experience.dark .loading-art-index{color:#8c8d87}
.loading-experience.dark .loading-art-caption b{color:#b7b8b0}
.loading-experience.dark .loading-art-index{color:#878880}
.loading-experience.dark .loading-status-row h1{color:#eeeeea}
.loading-experience.dark .loading-status-row p{color:#9c9d96}
.loading-experience.dark .loading-percent{color:#d6d7cf}
.loading-experience.dark .loading-percent small{color:#96978f}
.loading-experience.dark .loading-progress-track{background:rgba(220,221,210,.12)}
.loading-experience.dark .loading-progress-track i{background:linear-gradient(90deg,#7d9a8a,#b4c8b5 72%,#d0ad7a)}
.loading-experience.dark .loading-progress-track b{border:2px solid #28282b;background:#cfb07e}
.loading-experience.dark .loading-phases li{color:#767770}
.loading-experience.dark .loading-phase-marker{border:1px solid rgba(203,204,193,.17)}
.loading-experience.dark .loading-phase-marker i{background:#777871}
.loading-experience.dark .loading-phase-copy strong{color:#85867f}
.loading-experience.dark .loading-phase-copy small{color:#656660}
.loading-experience.dark .loading-phases li.complete .loading-phase-marker{border-color:rgba(143,179,158,.55);background:rgba(143,179,158,.1)}
.loading-experience.dark .loading-phases li.complete .loading-phase-marker i,.loading-experience.dark .loading-phases li.current .loading-phase-marker i{background:#a8c3b1}
.loading-experience.dark .loading-phases li.complete .loading-phase-copy strong{color:#b1c4b5}
.loading-experience.dark .loading-phases li.current .loading-phase-marker{border-color:rgba(201,174,130,.6)}
.loading-experience.dark .loading-phases li.current .loading-phase-marker i{background:#d1b17d}
.loading-experience.dark .loading-phases li.current .loading-phase-copy strong{color:#e1d1b1}
.loading-experience.dark .loading-footer{color:#7f8079}
.loading-experience.dark .loading-footer i{background:#b99c71}
.loading-experience.dark .loading-progress-track i{background:var(--loading-accent,#a8c3b1)}
.loading-phase-marker{border:0!important;background:transparent!important;box-shadow:none!important;color:var(--loading-accent,#2563eb)}
.loading-phase-marker svg{display:block;width:100%;height:100%;overflow:visible}
.phase-ring-track,.phase-ring-value{stroke:currentColor;stroke-width:1.8;fill:none}
.phase-ring-track{opacity:.18}.phase-ring-value{stroke-linecap:round;transition:stroke-dasharray .18s ease-out}
.phase-ring-check{stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.loading-phases li:not(.complete):not(.current) .loading-phase-marker{color:#98a7bf}
.loading-experience.dark .loading-phase-marker{color:var(--loading-accent,#a8c3b1)}
.loading-experience.dark .loading-phases li.current .loading-phase-marker{color:#d1b17d}
.loading-experience.dark .loading-phases li:not(.complete):not(.current) .loading-phase-marker{color:#777871}
@media(prefers-reduced-motion:reduce){.phase-ring-value{transition:none}}

</style>
