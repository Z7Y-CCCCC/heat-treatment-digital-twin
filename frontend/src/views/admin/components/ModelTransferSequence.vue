<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { TransferFeedScene } from '../../../three/TransferFeedScene.js'
import { FEED_STEPS, TRANSFER_MODEL_PROFILES, feedDurations, feedStepStart, sampleFeedSequence } from '../../../three/feedSequence.js'

const props = defineProps({ models: { type: Array, default: () => [] } })
const viewport = ref(null)
const modelId = ref('ultrasonic_cleaner_cad')
const choices = computed(() => Object.entries(TRANSFER_MODEL_PROFILES).map(([id, profile]) => ({
    id, label: profile.label, model: props.models.find(model => model.id === id && model.file_path)
})).filter(choice => choice.model))
const selected = computed(() => choices.value.find(choice => choice.id === modelId.value))
const cartModel = computed(() => props.models.find(model => model.id === 'photo_transfer_cart_v6' && model.file_path))
const ready = ref(false), error = ref(''), playing = ref(false), elapsed = ref(0), speed = ref(1), cutaway = ref(true)
const durations = reactive(feedDurations())
const frame = computed(() => sampleFeedSequence(elapsed.value, durations))
const activeLabel = computed(() => frame.value.complete ? '进料完成' : FEED_STEPS[frame.value.index].label)
const conditions = computed(() => [
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
            elapsed.value = Math.min(frame.value.total, elapsed.value + delta * speed.value)
            if (frame.value.complete) playing.value = false
        }
        scene.apply(frame.value)
    })
    runtime = scene
    try {
        await scene.load({ modelId: modelId.value, furnaceUrl: resolveBackendAssetUrl(selected.value.model.file_path),
            cartUrl: resolveBackendAssetUrl(cartModel.value.file_path), furnaceMetadata: selected.value.model.metadata })
        if (version !== generation) return
        scene.setCutaway(cutaway.value)
        ready.value = true
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
    if (frame.value.complete) elapsed.value = 0
    playing.value = !playing.value
}
function reset() { playing.value = false; elapsed.value = 0 }
function seekStep(index) {
    playing.value = false
    elapsed.value = feedStepStart(index, durations) + durations[FEED_STEPS[index].id] * .5
}
function seek(event) { playing.value = false; elapsed.value = Number(event.target.value) }
function normalizeTiming(id) { durations[id] = feedDurations(durations)[id] }
watch(modelId, loadScene)
watch(cutaway, value => runtime?.setCutaway(value))
watch(durations, reset, { deep: true })
onMounted(() => { mounted = true; loadScene() })
onActivated(() => runtime?.setActive(true))
onDeactivated(() => { playing.value = false; runtime?.setActive(false) })
onUnmounted(() => { mounted = false; generation++; runtime?.dispose(); runtime = null })
</script>

<template>
    <section class="transfer-sequence" data-testid="transfer-sequence-page">
        <aside class="sequence-controls">
            <header class="sequence-heading"><div><h3>进料联动</h3><p>料车定位后，依次开门、送料、退链、关门。</p></div><span class="demo-badge">动作演示</span></header>
            <label class="model-choice">联动设备
                <select v-model="modelId" class="input" aria-label="选择进料联动设备">
                    <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.label }} · {{ choice.model.name || choice.id }}</option>
                </select>
            </label>
            <div class="cart-choice"><span>配套料车</span><strong>取料小车 V6</strong></div>
            <ol class="sequence-steps" aria-label="进料流程">
                <li v-for="(step, index) in FEED_STEPS" :key="step.id" :class="{ current: frame.index === index && !frame.complete, done: frame.index > index || frame.complete }">
                    <button type="button" :disabled="!ready" :aria-label="`查看${step.label}`" :aria-current="frame.index === index && !frame.complete ? 'step' : undefined" @click="seekStep(index)">
                        <span class="step-number">{{ frame.index > index || frame.complete ? '✓' : index + 1 }}</span>
                        <span><strong>{{ step.label }}</strong><small>{{ step.detail }}</small></span>
                        <span class="step-duration">{{ durations[step.id] }}s</span>
                    </button>
                </li>
            </ol>
            <details class="sequence-timing">
                <summary>动作时长设置</summary>
                <div><label v-for="step in FEED_STEPS" :key="step.id">{{ step.label }}（秒）<input v-model.number="durations[step.id]" class="input" type="number" min="0.2" max="120" step="0.1" :disabled="playing" @change="normalizeTiming(step.id)" /></label></div>
            </details>
            <div class="playback-controls">
                <button type="button" class="btn btn-primary" :disabled="!ready" @click="togglePlayback">{{ playing ? '暂停' : frame.complete ? '再演示一次' : elapsed ? '继续演示' : '开始进料演示' }}</button>
                <button type="button" class="btn" :disabled="!ready" @click="reset">复位</button>
                <select v-model.number="speed" class="input" aria-label="联动演示速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select>
            </div>
            <p class="sequence-note">现场跟随需绑定料车定位、门到位、推链位置和有料信号。</p>
        </aside>
        <div class="sequence-preview">
            <header class="preview-heading"><div><strong>{{ selected?.label || '设备' }} × 取料小车</strong><small>推链送料 · 物料留机 · 自动退链</small></div><div class="preview-actions"><label><input v-model="cutaway" type="checkbox" />内部透视</label><button class="btn btn-sm" type="button" :disabled="!ready" @click="runtime?.focusTransfer()">送料近景</button><button class="btn btn-sm" type="button" :disabled="!ready" @click="runtime?.resetCamera()">完整视图</button></div></header>
            <div class="sequence-stage">
                <div ref="viewport" class="sequence-canvas"></div>
                <div v-if="!ready" class="sequence-loading" role="status"><strong>{{ error ? '模型未加载' : '正在加载设备与料车…' }}</strong><p v-if="error">{{ error }}</p><button v-if="error" type="button" class="btn" @click="loadScene">重新加载</button></div>
                <div v-if="ready" class="sequence-hud"><div><span>{{ frame.complete ? '本次流程完成' : `步骤 ${frame.index + 1} / 5` }}</span><strong>{{ activeLabel }}</strong></div><p>{{ frame.complete ? '物料已留在设备内，推链归零，炉门关闭。' : FEED_STEPS[frame.index].detail }}</p></div>
            </div>
            <div class="sequence-status" aria-label="联动到位状态"><span v-for="condition in conditions" :key="condition.name" :class="{ active: condition.active }"><i></i>{{ condition.name }}</span></div>
            <footer class="sequence-timeline"><label>流程进度<input type="range" min="0" :max="frame.total" step="0.01" :value="elapsed" :disabled="!ready" aria-label="进料流程进度" @input="seek" /></label><span>{{ elapsed.toFixed(1) }} / {{ frame.total.toFixed(1) }} 秒</span></footer>
        </div>
    </section>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.transfer-sequence { display: grid; flex: 1; grid-template-columns: minmax(290px, .65fr) minmax(0, 1.5fr); gap: 14px; min-height: 0; }
.sequence-controls, .sequence-preview { min-width: 0; min-height: 0; background: white; border: 1px solid #e0e7ef; border-radius: 14px; overflow: hidden; }
.sequence-controls { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto; }
.sequence-heading { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
h3 { margin: 0 0 5px; color: #273c55; font-size: 17px; }
.sequence-heading p { color: #8492a4; font-size: 11px; line-height: 1.6; margin: 0; }
.demo-badge { flex: 0 0 auto; background: #edf4ff; color: #3b73c9; border: 1px solid #d6e6ff; border-radius: 20px; padding: 5px 8px; font-size: 10px; }
.model-choice { display: grid; gap: 6px; color: #637890; font-size: 11px; }
.model-choice select { min-width: 0; width: 100%; box-sizing: border-box; font-size: 12px; }
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
.sequence-timing > div { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.sequence-timing label { display: grid; gap: 5px; }
.sequence-timing input { min-width: 0; max-width: 100%; box-sizing: border-box; font-size: 12px; }
.playback-controls { display: flex; align-items: center; gap: 7px; }
.playback-controls .btn { padding: 9px 10px; font-size: 12px; white-space: nowrap; }
.playback-controls .btn-primary { flex: 1; }
.playback-controls select { width: 65px; padding: 8px 4px; font-size: 11px; }
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
