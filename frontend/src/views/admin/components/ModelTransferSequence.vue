<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { TransferFeedScene } from '../../../three/TransferFeedScene.js'
import { FEED_STEPS, TRANSFER_MODEL_PROFILES, feedStepStart, sampleFeedSequence } from '../../../three/feedSequence.js'
import { CLEANER_PROCESS_STEPS, cleanerDurations, cleanerStepStart, sampleCleanerProcess } from '../../../three/cleanerProcess.js'

const props = defineProps({ models: { type: Array, default: () => [] }, initialStage: { type: String, default: '' }, inlinePreview: { type: Boolean, default: false } })
const emit = defineEmits(['close-preview'])
const viewport = ref(null)
const modelId = ref('ultrasonic_cleaner_cad')
const choices = computed(() => Object.entries(TRANSFER_MODEL_PROFILES).map(([id, profile]) => ({
    id, label: profile.label, model: props.models.find(model => model.id === id && model.file_path)
})).filter(choice => choice.model))
const selected = computed(() => choices.value.find(choice => choice.id === modelId.value))
const cartModel = computed(() => props.models.find(model => model.id === 'photo_transfer_cart_v6' && model.file_path))
const ready = ref(false), error = ref(''), playing = ref(false), elapsed = ref(0), speed = ref(1), cutaway = ref(true)
const processMode = ref('cleaning'), stepPage = ref(0)
const followProcess = ref(true)
const singlePreview = ref(null)
const timeline = computed(() => props.inlinePreview && singlePreview.value
    ? { elapsed: elapsed.value - singlePreview.value.start, total: singlePreview.value.end - singlePreview.value.start + .00001 }
    : { elapsed: elapsed.value, total: frame.value.total })
const isCleaner = computed(() => modelId.value === 'ultrasonic_cleaner_cad')
const cleaning = computed(() => isCleaner.value && processMode.value === 'cleaning')
const steps = computed(() => cleaning.value ? CLEANER_PROCESS_STEPS : FEED_STEPS)
const durations = reactive(cleanerDurations())
const frame = computed(() => cleaning.value ? sampleCleanerProcess(elapsed.value, durations) : sampleFeedSequence(elapsed.value, durations))
const activeLabel = computed(() => frame.value.complete ? cleaning.value ? '清洗完成 · 待出料' : '进料完成' : steps.value[frame.value.index].label)
const pageCount = computed(() => Math.ceil(steps.value.length / 6))
const visibleSteps = computed(() => steps.value.slice(stepPage.value * 6, stepPage.value * 6 + 6).map((step, offset) => ({ ...step, index: stepPage.value * 6 + offset })))
const processIndicators = computed(() => [
    { key: 'fill', label: '进液' }, { key: 'heat', label: '加热' }, { key: 'spray', label: '喷淋' },
    { key: 'ultrasonic', label: '超声' }, { key: 'drain', label: '回液' }, { key: 'blow', label: '吹扫' }
])
const cycleOverview = [
    { label: '进料', stages: ['approach', 'open', 'feed', 'retract', 'close'] },
    { label: '注液', stages: ['fill'] }, { label: '加热', stages: ['heat'] },
    { label: '喷淋', stages: ['spray'] }, { label: '超声', stages: ['ultrasonic'] },
    { label: '排液', stages: ['drain'] }, { label: '吹扫', stages: ['blow'] },
    { label: '开门待出料', stages: ['unseal'] }
]
const conditions = computed(() => cleaning.value ? [
    { name: '门已关闭', active: frame.value.door === 0 },
    { name: '工作液位', active: frame.value.process.level >= .99 },
    { name: '推链归零', active: frame.value.chainHome },
    { name: '物料入机', active: frame.value.materialInFurnace }
] : [
    { name: '料车到位', active: frame.value.cartAtFurnace },
    { name: '门开到位', active: frame.value.doorOpen },
    { name: '推链归零', active: frame.value.chainHome },
    { name: '物料入机', active: frame.value.materialInFurnace }
])
let runtime = null, generation = 0, mounted = false

async function loadScene() {
    if (!mounted) return
    const version = ++generation
    playing.value = false
    elapsed.value = 0
    stepPage.value = 0
    singlePreview.value = null
    ready.value = false
    error.value = ''
    runtime?.dispose()
    runtime = null
    if (!selected.value || !cartModel.value) {
        error.value = '模型库中缺少清洗机 / 炉子或取料小车模型。'
        return
    }
    await nextTick()
    if (version !== generation || !viewport.value) return
    const scene = new TransferFeedScene(viewport.value, delta => {
        if (!ready.value || version !== generation) return
        if (playing.value) {
            const end = singlePreview.value?.end ?? frame.value.total
            elapsed.value = Math.min(end, elapsed.value + delta * speed.value)
            if (elapsed.value >= end) playing.value = false
        }
        scene.apply(frame.value)
    })
    runtime = scene
    try {
        await scene.load({ modelId: modelId.value, furnaceUrl: resolveBackendAssetUrl(selected.value.model.file_path),
            cartUrl: resolveBackendAssetUrl(cartModel.value.file_path), furnaceMetadata: selected.value.model.metadata, showTransfer: !props.inlinePreview })
        if (version !== generation) return
        scene.setCutaway(cutaway.value)
        ready.value = true
        if (props.inlinePreview) previewProcessStage(props.initialStage)
    } catch (cause) {
        if (version === generation) {
            error.value = `联动模型加载失败：${cause.message || cause}`
            scene.dispose()
            runtime = null
        }
    }
}

function togglePlayback() {
    if (!ready.value) return
    if (singlePreview.value && elapsed.value >= singlePreview.value.end) elapsed.value = singlePreview.value.start
    else if (frame.value.complete) elapsed.value = 0
    playing.value = !playing.value
}
function reset() { playing.value = false; elapsed.value = 0; stepPage.value = 0; singlePreview.value = null }
async function startCompleteCycle() {
    if (!ready.value || !isCleaner.value || props.inlinePreview) return
    processMode.value = 'cleaning'
    await nextTick()
    reset()
    runtime?.resetCamera()
    playing.value = true
}
function followCurrentPhase() {
    if (!ready.value || !cleaning.value || props.inlinePreview || !followProcess.value) return
    if (frame.value.index >= 5 && frame.value.index <= 10) runtime?.focusProcess()
    else if (frame.value.index === 11) runtime?.focusTransfer()
    else runtime?.resetCamera()
}
async function previewProcessStage(id) {
    if (!ready.value || !isCleaner.value || !props.inlinePreview) return
    const index = CLEANER_PROCESS_STEPS.findIndex(step => step.id === id)
    if (index < 5 || index > 10) return
    processMode.value = 'cleaning'
    await nextTick()
    if (!mounted || !ready.value) return
    const start = cleanerStepStart(index, durations)
    singlePreview.value = { start, end: start + durations[id] - .00001 }
    elapsed.value = start
    stepPage.value = Math.floor(index / 6)
    playing.value = true
    runtime?.focusProcess()
}
function seekStep(index) {
    playing.value = false
    singlePreview.value = null
    elapsed.value = (cleaning.value ? cleanerStepStart(index, durations) : feedStepStart(index, durations)) + durations[steps.value[index].id] * .5
}
function seek(event) {
    playing.value = false
    if (props.inlinePreview && singlePreview.value) elapsed.value = Math.min(singlePreview.value.end, singlePreview.value.start + Number(event.target.value))
    else { singlePreview.value = null; elapsed.value = Number(event.target.value) }
}
function normalizeTiming(id) { durations[id] = cleanerDurations(durations)[id] }
watch(modelId, loadScene)
watch(() => props.initialStage, value => { if (props.inlinePreview) previewProcessStage(value) })
watch(cleaning, reset)
watch(() => frame.value.index, (index, previous) => {
    stepPage.value = Math.floor(index / 6)
    const phase = value => value < 5 ? 'feed' : value < 11 ? 'clean' : 'unload'
    if (phase(index) !== phase(previous) || index === 0) followCurrentPhase()
})
watch(followProcess, followCurrentPhase)
watch(cutaway, value => runtime?.setCutaway(value))
watch(durations, reset, { deep: true })
defineExpose({ previewProcessStage })
onMounted(() => { mounted = true; loadScene() })
onActivated(() => runtime?.setActive(true))
onDeactivated(() => { playing.value = false; runtime?.setActive(false) })
onUnmounted(() => { mounted = false; generation++; runtime?.dispose(); runtime = null })
</script>

<template>
    <section class="transfer-sequence" :class="{ 'inline-preview': inlinePreview }" data-testid="transfer-sequence-page" :data-requested-stage="initialStage" :data-preview-scope="singlePreview ? 'step' : 'cycle'">
        <aside v-if="!inlinePreview" class="sequence-controls">
            <header class="sequence-heading"><div><h3>设备联动</h3><p>{{ cleaning ? '进料后自动继续注液、清洗、排液与吹扫。' : '料车定位后，依次开门、送料、退链、关门。' }}</p></div><span class="demo-badge">模拟演示</span></header>
            <label class="model-choice">联动设备
                <select v-model="modelId" class="input" aria-label="选择进料联动设备">
                    <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.label }} · {{ choice.model.name || choice.id }}</option>
                </select>
            </label>
            <div v-if="isCleaner" class="process-modes" role="group" aria-label="演示流程">
                <button type="button" :class="{ active: cleaning }" :aria-pressed="cleaning" @click="processMode = 'cleaning'; reset()">进料＋清洗联动</button>
                <button type="button" :class="{ active: !cleaning }" :aria-pressed="!cleaning" @click="processMode = 'feed'; reset()">仅进料</button>
            </div>
            <div class="cart-choice"><span>配套料车</span><strong>取料小车 V6</strong></div>
            <div class="step-navigation"><span>工步 {{ stepPage * 6 + 1 }}–{{ Math.min((stepPage + 1) * 6, steps.length) }} / {{ steps.length }}</span><div v-if="pageCount > 1"><button type="button" aria-label="上一页工步" :disabled="stepPage === 0" @click="stepPage--">上一页</button><button type="button" aria-label="下一页工步" :disabled="stepPage >= pageCount - 1" @click="stepPage++">下一页</button></div></div>
            <ol class="sequence-steps" :start="stepPage * 6 + 1" aria-label="设备联动工步">
                <li v-for="step in visibleSteps" :key="step.id" :class="{ current: frame.index === step.index && !frame.complete, done: frame.index > step.index || frame.complete }">
                    <button type="button" :disabled="!ready" :aria-label="`查看${step.label}`" :aria-current="frame.index === step.index && !frame.complete ? 'step' : undefined" @click="seekStep(step.index)">
                        <span class="step-number">{{ frame.index > step.index || frame.complete ? '✓' : step.index + 1 }}</span>
                        <span><strong>{{ step.label }}</strong><small>{{ step.detail }}</small></span>
                        <span class="step-duration">{{ durations[step.id] }}s</span>
                    </button>
                </li>
            </ol>
            <details class="sequence-timing">
                <summary>动作时长设置</summary>
                <div><label v-for="step in steps" :key="step.id">{{ step.label }}（秒）<input v-model.number="durations[step.id]" class="input" type="number" min="0.2" max="120" step="0.1" :disabled="playing" @change="normalizeTiming(step.id)" /></label></div>
            </details>
            <div class="playback-controls">
                <button type="button" class="btn btn-primary" :disabled="!ready" @click="togglePlayback">{{ playing ? '暂停' : singlePreview && elapsed >= singlePreview.end ? '重播本工步' : frame.complete ? '再演示一次' : elapsed ? '继续演示' : cleaning ? '开始清洗演示' : '开始进料演示' }}</button>
                <button type="button" class="btn" :disabled="!ready" @click="reset">复位</button>
                <select v-model.number="speed" class="input" aria-label="联动演示速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select>
            </div>
            <button v-if="isCleaner" type="button" class="full-cycle-play" :disabled="!ready" @click="startCompleteCycle">从头播放完整联动 · {{ sampleCleanerProcess(0, durations).total.toFixed(0) }} 秒</button>
            <p class="sequence-note">{{ cleaning ? '清洗腔注液、回液流向及温度均为工艺示意，时序以现场工艺为准。' : '现场跟随需绑定料车定位、门到位、推链位置和有料信号。' }}</p>
        </aside>
        <div class="sequence-preview">
            <header class="preview-heading"><div><strong>{{ inlinePreview ? `${selected?.label || '清洗机'} · ${activeLabel}` : `${selected?.label || '设备'} × 取料小车` }}</strong><small>{{ inlinePreview ? '工艺动作 · 当前页面预览' : cleaning ? '进料后连续执行全部清洗工步' : '推链送料 · 物料留机 · 自动退链' }}</small></div><div class="preview-actions"><label v-if="cleaning && !inlinePreview"><input v-model="followProcess" type="checkbox" />自动跟随工步</label><label><input v-model="cutaway" type="checkbox" />内部透视</label><button v-if="cleaning" class="btn btn-sm" type="button" :disabled="!ready" @click="runtime?.focusProcess()">工艺近景</button><button v-if="!inlinePreview" class="btn btn-sm" type="button" :disabled="!ready" @click="runtime?.focusTransfer()">送料近景</button><button class="btn btn-sm" type="button" :disabled="!ready" @click="runtime?.resetCamera()">完整视图</button></div></header>
            <ol v-if="cleaning && !inlinePreview" class="cycle-overview" aria-label="完整联动流程"><li v-for="phase in cycleOverview" :key="phase.label" :class="{ active: phase.stages.includes(frame.stage) }" :aria-current="phase.stages.includes(frame.stage) ? 'step' : undefined">{{ phase.label }}</li></ol>
            <div class="sequence-stage">
                <div ref="viewport" class="sequence-canvas"></div>
                <div v-if="!ready" class="sequence-loading" role="status"><strong>{{ error ? '模型未加载' : '正在加载设备与料车…' }}</strong><p v-if="error">{{ error }}</p><button v-if="error" type="button" class="btn" @click="loadScene">重新加载</button></div>
                <div v-if="ready && cleaning" class="process-readings" aria-label="工艺模拟读数"><span>模拟液位<strong>{{ Math.round(frame.process.level * 100) }}<small>%</small></strong></span><span>模拟温度<strong>{{ frame.process.temperature.toFixed(1) }}<small>℃</small></strong></span><div><i></i>工艺演示 · 未连接 PLC</div></div>
                <div v-if="ready" class="sequence-hud"><div><span>{{ inlinePreview ? '工艺动作预览' : frame.complete ? '本次流程完成' : `步骤 ${frame.index + 1} / ${steps.length}` }}</span><strong>{{ activeLabel }}</strong></div><p>{{ frame.complete ? cleaning ? '清洗及吹扫结束，门已打开，物料留机等待出料。' : '物料已留在设备内，推链归零，炉门关闭。' : steps[frame.index].detail }}</p></div>
            </div>
            <div v-if="cleaning" class="process-indicators" aria-label="工艺运行状态"><span v-for="indicator in processIndicators" :key="indicator.key" :class="{ active: frame.process[indicator.key] }"><i></i>{{ indicator.label }}</span></div>
            <div v-if="!inlinePreview" class="sequence-status" aria-label="联动到位状态"><span v-for="condition in conditions" :key="condition.name" :class="{ active: condition.active }"><i></i>{{ condition.name }}</span></div>
            <footer class="sequence-timeline"><button v-if="inlinePreview" type="button" class="btn btn-sm" :disabled="!ready" @click="togglePlayback">{{ playing ? '暂停' : singlePreview && elapsed >= singlePreview.end ? '重播' : '播放' }}</button><button v-if="inlinePreview" type="button" class="btn btn-sm" @click="emit('close-preview')">停止预览</button><label>{{ inlinePreview ? '动作进度' : '流程进度' }}<input type="range" min="0" :max="timeline.total" step="0.01" :value="timeline.elapsed" :disabled="!ready" :aria-label="inlinePreview ? '工艺动作进度' : '设备联动流程进度'" @input="seek" /></label><span>{{ timeline.elapsed.toFixed(1) }} / {{ timeline.total.toFixed(1) }} 秒</span></footer>
        </div>
    </section>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.transfer-sequence { display: grid; flex: 1; grid-template-columns: minmax(290px, .65fr) minmax(0, 1.5fr); gap: 14px; min-height: 0; }
.transfer-sequence.inline-preview { display: flex; width: 100%; height: 100%; min-height: 0; }
.inline-preview .sequence-preview { flex: 1; border: 0; border-radius: 0; min-height: 0; }
.inline-preview .sequence-timeline { flex-wrap: wrap; gap: 8px; }
.inline-preview .sequence-timeline .btn { font-size: 11px; padding: 6px 9px; }
.sequence-controls, .sequence-preview { min-width: 0; min-height: 0; background: white; border: 1px solid #e0e7ef; border-radius: 14px; overflow: hidden; }
.sequence-controls { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto; }
.sequence-heading { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
h3 { margin: 0 0 5px; color: #273c55; font-size: 17px; }
.sequence-heading p { color: #8492a4; font-size: 11px; line-height: 1.6; margin: 0; }
.demo-badge { flex: 0 0 auto; background: #edf4ff; color: #3b73c9; border: 1px solid #d6e6ff; border-radius: 20px; padding: 5px 8px; font-size: 10px; }
.model-choice { display: grid; gap: 6px; color: #637890; font-size: 11px; }
.model-choice select { min-width: 0; width: 100%; box-sizing: border-box; font-size: 12px; }
.process-modes { display: flex; gap: 3px; background: #f0f4f9; border: 1px solid #e3eaf2; border-radius: 8px; padding: 3px; }
.process-modes button { flex: 1; border: 0; background: transparent; border-radius: 6px; padding: 7px 4px; font-size: 11px; color: #8294aa; cursor: pointer; }
.process-modes button.active { background: #fff; color: #2d76d4; font-weight: 600; box-shadow: 0 1px 5px #2c456215; }
.step-navigation { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10px; color: #8c9bb0; }
.step-navigation > div { display: flex; gap: 5px; }
.step-navigation button { border: 1px solid #dfE7f0; border-radius: 5px; padding: 4px 7px; background: #fff; color: #6683a7; cursor: pointer; font-size: 10px; }
.step-navigation button:disabled { opacity: .35; cursor: default; }
.cart-choice { display: flex; justify-content: space-between; gap: 8px; color: #8694a7; font-size: 11px; padding: 1px 2px 4px; }
.cart-choice strong { color: #4c627e; font-weight: 500; }
.sequence-steps { display: grid; flex: 1; gap: 6px; min-height: 250px; list-style: none; padding: 0; margin: 0; }
.sequence-steps li { min-height: 0; }
.sequence-steps button { display: flex; width: 100%; height: 100%; align-items: center; gap: 10px; border: 1px solid #e7ecf2; padding: 9px 10px; background: #fbfcfe; color: #7b8ba0; border-radius: 10px; text-align: left; cursor: pointer; }
.sequence-steps button:disabled { cursor: wait; opacity: .6; }
.sequence-steps .current button { background: #edf5ff; border-color: #8db5ef; color: #2c6cc7; box-shadow: inset 3px 0 #4086e8; }
.sequence-steps .done button { background: #f6fbf9; border-color: #deeee5; }
.step-number { flex: 0 0 26px; width: 26px; height: 26px; display: grid; place-items: center; background: #edf0f5; border-radius: 50%; font-size: 11px; font-weight: 700; }
.current .step-number { color: #fff; background: #468bea; }
.done .step-number { color: #32946d; background: #e3f3eb; }
.sequence-steps strong { display: block; font-size: 12px; margin-bottom: 4px; }
.sequence-steps small { display: block; color: #8697ab; font-size: 10px; line-height: 1.4; }
.step-duration { margin-left: auto; font-size: 10px; color: #92a0b2; white-space: nowrap; }
.sequence-timing { font-size: 11px; color: #7990aa; }
.sequence-timing summary { cursor: pointer; }
.sequence-timing > div { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; max-height: 180px; overflow-y: auto; }
.sequence-timing label { display: grid; gap: 5px; }
.sequence-timing input { min-width: 0; max-width: 100%; box-sizing: border-box; font-size: 12px; }
.playback-controls { display: flex; align-items: center; gap: 7px; }
.playback-controls .btn { padding: 9px 10px; font-size: 12px; white-space: nowrap; }
.playback-controls .btn-primary { flex: 1; }
.playback-controls select { width: 65px; padding: 8px 4px; font-size: 11px; }
.full-cycle-play { border: 1px solid #c9def4; border-radius: 7px; background: #edf6ff; color: #387bbb; padding: 8px; font-size: 11px; cursor: pointer; }
.full-cycle-play:disabled { opacity: .5; cursor: wait; }
.cycle-overview { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 5px; list-style: none; padding: 8px 16px; margin: 0; background: #f8fbfd; border-bottom: 1px solid #e8edf3; }
.cycle-overview li { display: flex; align-items: center; gap: 5px; padding: 4px 6px; color: #8b9db1; font-size: 10px; border-radius: 5px; }
.cycle-overview li:not(:last-child)::after { content: '→'; color: #bac8d6; }
.cycle-overview li.active { color: #217ba9; background: #e1f3fc; font-weight: 600; }
.sequence-note { margin: 0; color: #96a3b4; font-size: 10px; line-height: 1.6; }
.sequence-preview { display: flex; flex-direction: column; }
.preview-heading { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 16px; border-bottom: 1px solid #e8edf3; }
.preview-heading strong { display: block; font-size: 14px; color: #324965; }
.preview-heading small { display: block; margin-top: 5px; color: #93a1b2; font-size: 10px; }
.preview-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
.preview-actions label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #7488a0; white-space: nowrap; }
.preview-actions .btn { font-size: 11px; padding: 6px 9px; }
.sequence-stage { flex: 1; min-height: 320px; position: relative; overflow: hidden; background: #eef3f7; }
.sequence-canvas { position: absolute; inset: 0; }
.sequence-canvas :deep(canvas) { display: block; }
.sequence-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #f3f6f9e8; color: #627a92; padding: 24px; text-align: center; font-size: 12px; }
.sequence-loading p { overflow-wrap: anywhere; }
.sequence-hud { position: absolute; left: 16px; bottom: 16px; min-width: 210px; max-width: calc(100% - 64px); padding: 12px 16px; color: #405b79; background: #ffffffec; border: 1px solid #dfe9f4; border-radius: 10px; box-shadow: 0 4px 24px #294b6a0c; pointer-events: none; }
.sequence-hud > div { display: flex; align-items: center; gap: 12px; }
.sequence-hud span { font-size: 10px; color: #89a0b9; }
.sequence-hud strong { font-size: 14px; color: #296cc7; }
.sequence-hud p { font-size: 11px; margin: 7px 0 0; color: #8596a9; }
.process-readings { position: absolute; top: 16px; left: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; padding: 12px 16px; background: #ffffffee; border: 1px solid #dfe9f4; border-radius: 10px; pointer-events: none; }
.process-readings > span { color: #8398ae; font-size: 10px; }
.process-readings strong { display: block; color: #2d789d; font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.process-readings small { margin-left: 4px; font-size: 10px; font-weight: 400; }
.process-readings > div { grid-column: 1 / -1; font-size: 9px; color: #92a1b3; }
.process-readings i { display: inline-block; width: 5px; height: 5px; background: #edb552; border-radius: 50%; margin-right: 5px; }
.process-indicators { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 16px 0; }
.process-indicators span { display: flex; align-items: center; gap: 5px; padding: 5px 9px; background: #f1f5f8; color: #9aa9ba; border-radius: 20px; font-size: 10px; }
.process-indicators i { width: 5px; height: 5px; border-radius: 50%; background: #c6d2dd; }
.process-indicators .active { background: #e2f4fc; color: #2389b2; }
.process-indicators .active i { background: #20a4d2; }
.sequence-status { display: grid; flex: 0 0 auto; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 16px 4px; }
.sequence-status span { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 3px; background: #f3f5f8; color: #97a2b1; border-radius: 6px; font-size: 11px; }
.sequence-status i { width: 5px; height: 5px; border-radius: 50%; background: #bcc5d0; }
.sequence-status .active { color: #35916c; background: #ecf8f1; }
.sequence-status .active i { background: #47ac7f; }
.sequence-timeline { display: flex; flex: 0 0 auto; align-items: center; gap: 15px; padding: 9px 16px 12px; color: #95a3b3; font-size: 10px; }
.sequence-timeline label { display: flex; flex: 1; align-items: center; gap: 10px; white-space: nowrap; }
.sequence-timeline input { flex: 1; min-width: 0; accent-color: #4c8ae4; }
.sequence-timeline > span { white-space: nowrap; }
@media (max-width: 1050px) { .transfer-sequence { display: flex; flex-direction: column; } .sequence-preview { order: -1; min-height: 560px; } .sequence-controls { min-height: 520px; } }
@media (max-height: 800px) and (min-width: 1051px) {
    .sequence-controls { gap: 8px; padding: 12px; }
    .sequence-heading p, .cart-choice, .sequence-note, .sequence-steps small { display: none; }
    .sequence-steps { min-height: 185px; }
    .sequence-steps button { padding: 6px 9px; }
}
</style>
