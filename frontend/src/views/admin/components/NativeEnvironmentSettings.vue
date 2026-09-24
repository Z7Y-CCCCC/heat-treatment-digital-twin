<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import NativeWallEditor from './NativeWallEditor.vue'

const props = defineProps({
    config: { type: Object, required: true },
    saving: { type: Boolean, default: false },
    message: { type: String, default: '' },
    presetOptions: { type: Array, default: () => [] },
    workshops: { type: Array, default: () => [] },
    lines: { type: Array, default: () => [] },
    devices: { type: Array, default: () => [] }
})

const emit = defineEmits(['save', 'apply-preset', 'reset'])

const colorItems = [
    ['skyColor', '天空'],
    ['horizonColor', '地平线'],
    ['fogColor', '雾效'],
    ['keyLightColor', '主光'],
    ['fillLightColor', '补光'],
    ['floorColor', '地面'],
    ['gridColor', '网格'],
    ['wallColor', '厂房墙面'],
    ['frameColor', '钢结构']
]

const presetDescription = computed(() => (
    props.presetOptions.find(option => option.value === props.config.preset)?.description
    || '当前为工程师自定义组合。'
))

const visualPresetOptions = computed(() => (
    props.presetOptions.filter(option => option.value !== 'custom')
))

const showCustomPreview = computed(() => props.config.preset === 'custom')

const appliedFeedback = ref(false)
let appliedFeedbackTimer = null

const messageTone = computed(() => {
    const text = String(props.message || '')
    if (!text) return ''
    if (/失败|错误|异常/.test(text)) return 'error'
    if (/已保存|实时应用/.test(text)) return 'success'
    if (/点击“立即应用”/.test(text)) return 'info'
    if (/正在|应用中|推送/.test(text)) return 'pending'
    return 'info'
})

watch(() => props.message, (message) => {
    const text = String(message || '')
    if (/已保存|实时应用/.test(text) && !/失败|错误|异常/.test(text)) {
        appliedFeedback.value = true
        if (appliedFeedbackTimer) clearTimeout(appliedFeedbackTimer)
        appliedFeedbackTimer = setTimeout(() => {
            appliedFeedback.value = false
            appliedFeedbackTimer = null
        }, 2800)
    } else if (/失败|错误|异常|点击“立即应用”/.test(text)) {
        appliedFeedback.value = false
    }
})

onUnmounted(() => {
    if (appliedFeedbackTimer) clearTimeout(appliedFeedbackTimer)
})

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0))
}

function presetPreviewStyle(option) {
    const source = option?.preview || props.config
    const brightness = clamp(
        Number(source.sceneBrightness || 1) * Math.pow(2, Number(source.postExposure || 0) * 0.28),
        0.65,
        1.55
    )
    const saturation = clamp(1 + Number(source.saturation || 0) / 50, 0.65, 1.5)
    const contrast = clamp(1 + Number(source.contrast || 0) / 60, 0.78, 1.5)
    const fogOpacity = source.fogEnabled === false
        ? 0
        : clamp(0.13 + (420 - Number(source.fogEnd || 360)) / 1200, 0.06, 0.32)

    return {
        '--preview-sky': source.skyColor || '#696969',
        '--preview-horizon': source.horizonColor || '#464646',
        '--preview-fog': source.fogColor || '#565656',
        '--preview-key': source.keyLightColor || '#F2F2F2',
        '--preview-fill': source.fillLightColor || '#EAEAEA',
        '--preview-floor': source.floorColor || '#5B5B5B',
        '--preview-grid': source.gridColor || '#777777',
        '--preview-wall': source.wallColor || '#5A5A5A',
        '--preview-frame': source.frameColor || '#9A9A9A',
        '--preview-brightness': brightness.toFixed(2),
        '--preview-saturation': saturation.toFixed(2),
        '--preview-contrast': contrast.toFixed(2),
        '--preview-fog-opacity': fogOpacity.toFixed(2),
        '--preview-grid-opacity': source.showGrid === false ? '0' : '0.68',
        '--preview-bloom-opacity': clamp(0.1 + Number(source.bloomIntensity || 0) * 1.8, 0.08, 0.48).toFixed(2),
        '--preview-vignette-opacity': clamp(0.06 + Number(source.vignetteIntensity || 0) * 0.9, 0.06, 0.36).toFixed(2),
        '--preview-glow-size': `${(7 * clamp(Number(source.reflectionIntensity || 1), 0.35, 1.6)).toFixed(1)}px`
    }
}

const customPreviewStyle = computed(() => presetPreviewStyle({ preview: props.config }))

function selectPreset(option) {
    if (!option || option.value === 'custom' || props.saving) return
    emit('apply-preset', option.value)
}

function saveCustom() {
    props.config.preset = 'custom'
    emit('save', { silent: true, markCustom: true })
}
</script>

<template>
    <section class="environment-settings">
        <div class="environment-heading">
            <div>
                <h3>Unity 场景与光效</h3>
                <p>灯光、曝光和雾效作用于整个场景；导入厂房保留模型原始材质。地面、墙面及钢结构颜色只控制程序生成的底板与围墙。保存后实时应用，不重载设备模型。</p>
            </div>
            <div class="environment-actions">
                <div class="environment-action-buttons">
                    <button type="button" class="env-btn" :disabled="saving" @click="emit('reset')">恢复推荐值</button>
                    <button
                        type="button"
                        class="env-btn primary"
                        :class="{ 'is-busy': saving, 'is-applied': appliedFeedback && !saving }"
                        :disabled="saving"
                        :aria-busy="saving"
                        @click="emit('save', {})"
                    >
                        <span v-if="saving" class="env-btn-spinner" aria-hidden="true"></span>
                        <span>{{ saving ? '正在应用...' : appliedFeedback ? '已应用到 Unity ✓' : '立即应用到 Unity' }}</span>
                    </button>
                </div>
                <p
                    v-if="message"
                    class="environment-message"
                    :class="`is-${messageTone}`"
                    :role="messageTone === 'error' ? 'alert' : 'status'"
                    aria-live="polite"
                >
                    <span class="environment-message-icon" aria-hidden="true">
                        {{ messageTone === 'error' ? '!' : messageTone === 'success' ? '✓' : messageTone === 'pending' ? '◌' : 'i' }}
                    </span>
                    <span>{{ message }}</span>
                </p>
            </div>
        </div>

        <div class="preset-panel">
            <div class="preset-panel-heading">
                <div>
                    <strong>视觉预设</strong>
                    <p>{{ presetDescription }}</p>
                </div>
                <label class="check-line"><input v-model="config.showGrid" type="checkbox" @change="saveCustom" /> 显示地面网格</label>
            </div>

            <div class="preset-gallery" role="radiogroup" aria-label="Unity 场景视觉预设">
                <button
                    v-for="option in visualPresetOptions"
                    :key="option.value"
                    type="button"
                    class="preset-card"
                    :class="{ 'is-active': config.preset === option.value }"
                    :aria-checked="config.preset === option.value"
                    :disabled="saving"
                    role="radio"
                    @click="selectPreset(option)"
                >
                    <span class="preset-thumbnail" :style="presetPreviewStyle(option)" aria-hidden="true">
                        <span class="preset-scene">
                            <i class="preset-sky"></i>
                            <i class="preset-horizon"></i>
                            <i class="preset-floor"></i>
                            <i class="preset-floor-grid"></i>
                            <i class="preset-machine is-back"></i>
                            <i class="preset-machine is-middle"></i>
                            <i class="preset-machine is-front"></i>
                            <i class="preset-light"></i>
                            <i class="preset-vignette"></i>
                        </span>
                        <b v-if="config.preset === option.value" class="preset-selected">✓</b>
                    </span>
                    <span class="preset-card-copy">
                        <span class="preset-name-row">
                            <strong>{{ option.label }}</strong>
                            <small v-if="option.tag">{{ option.tag }}</small>
                        </span>
                        <span>{{ option.description }}</span>
                    </span>
                </button>

                <div v-if="showCustomPreview" class="preset-card is-active is-custom" role="radio" aria-checked="true">
                    <span class="preset-thumbnail" :style="customPreviewStyle" aria-hidden="true">
                        <span class="preset-scene">
                            <i class="preset-sky"></i>
                            <i class="preset-horizon"></i>
                            <i class="preset-floor"></i>
                            <i class="preset-floor-grid"></i>
                            <i class="preset-machine is-back"></i>
                            <i class="preset-machine is-middle"></i>
                            <i class="preset-machine is-front"></i>
                            <i class="preset-light"></i>
                            <i class="preset-vignette"></i>
                        </span>
                        <b class="preset-selected">✓</b>
                    </span>
                    <span class="preset-card-copy">
                        <span class="preset-name-row"><strong>当前自定义</strong><small>工程师配置</small></span>
                        <span>缩略图随下方亮度、颜色和后处理参数同步变化。</span>
                    </span>
                </div>
            </div>
        </div>

        <div class="environment-grid">
            <NativeWallEditor
                :config="config"
                :workshops="workshops"
                :lines="lines"
                :devices="devices"
                @change="saveCustom"
            />

            <section class="environment-card">
                <h4>总体亮度与照明</h4>
                <div class="control-list">
                    <label>全局亮度 <span>{{ Math.round(config.sceneBrightness * 100) }}%</span>
                        <input v-model.number="config.sceneBrightness" type="range" min="0.8" max="1.6" step="0.05" @change="saveCustom" />
                    </label>
                    <label>环境光强度 <span>{{ Number(config.ambientIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.ambientIntensity" type="range" min="0.2" max="2.5" step="0.05" @change="saveCustom" />
                    </label>
                    <label>主光强度 <span>{{ Number(config.keyLightIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.keyLightIntensity" type="range" min="0" max="3" step="0.05" @change="saveCustom" />
                    </label>
                    <label>补光强度 <span>{{ Number(config.fillLightIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.fillLightIntensity" type="range" min="0" max="2.5" step="0.05" @change="saveCustom" />
                    </label>
                    <label>环境反射 <span>{{ Number(config.reflectionIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.reflectionIntensity" type="range" min="0" max="2" step="0.05" @change="saveCustom" />
                    </label>
                </div>
            </section>

            <section class="environment-card">
                <h4>后处理</h4>
                <div class="control-list">
                    <label>曝光 <span>{{ Number(config.postExposure).toFixed(2) }}</span>
                        <input v-model.number="config.postExposure" type="range" min="-1.5" max="2" step="0.05" @change="saveCustom" />
                    </label>
                    <label>对比度 <span>{{ Math.round(config.contrast) }}</span>
                        <input v-model.number="config.contrast" type="range" min="-30" max="30" step="1" @change="saveCustom" />
                    </label>
                    <label>饱和度 <span>{{ Math.round(config.saturation) }}</span>
                        <input v-model.number="config.saturation" type="range" min="-30" max="30" step="1" @change="saveCustom" />
                    </label>
                    <label>高光柔化（Bloom） <span>{{ Number(config.bloomIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.bloomIntensity" type="range" min="0" max="1" step="0.01" @change="saveCustom" />
                    </label>
                    <label>画面暗角 <span>{{ Number(config.vignetteIntensity).toFixed(2) }}</span>
                        <input v-model.number="config.vignetteIntensity" type="range" min="0" max="0.5" step="0.01" @change="saveCustom" />
                    </label>
                </div>
            </section>

            <section class="environment-card">
                <div class="card-heading">
                    <h4>雾效与空间层次</h4>
                    <label class="switch">
                        <input v-model="config.fogEnabled" type="checkbox" @change="saveCustom" />
                        <span></span>
                    </label>
                </div>
                <div class="number-grid">
                    <label>雾效起始距离<input v-model.number="config.fogStart" class="env-input" type="number" min="0" max="500" @change="saveCustom" /></label>
                    <label>雾效结束距离<input v-model.number="config.fogEnd" class="env-input" type="number" min="10" max="1000" @change="saveCustom" /></label>
                </div>
                <p class="help">关闭雾效可获得最清晰的设备边缘；开启后更接近大型厂房的空间纵深。</p>
            </section>

            <section class="environment-card color-card">
                <h4>颜色与材质环境</h4>
                <div class="color-grid">
                    <label v-for="item in colorItems" :key="item[0]">
                        <span>{{ item[1] }}</span>
                        <input v-model="config[item[0]]" type="color" @change="saveCustom" />
                        <code>{{ config[item[0]] }}</code>
                    </label>
                </div>
            </section>
        </div>

    </section>
</template>

<style scoped>
.environment-settings { margin-top: 24px; padding: 24px; background: linear-gradient(180deg, #f5f9fc 0%, #fbfbfd 100%); border: 1px solid #e2e7eb; border-radius: 12px; }
.environment-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.environment-heading h3 { margin: 0 0 8px; color: #1d1d1f; font-size: 17px; }
.environment-heading p { max-width: 760px; margin: 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.environment-actions { display: flex; flex: 0 0 auto; min-width: 320px; flex-direction: column; align-items: stretch; gap: 8px; }
.environment-action-buttons { display: flex; justify-content: flex-end; gap: 10px; }
.env-btn { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; gap: 8px; padding: 7px 15px; color: #343437; background: #fff; border: 1px solid #cfd3d7; border-radius: 7px; cursor: pointer; transition: transform .12s ease, background-color .16s ease, border-color .16s ease, box-shadow .16s ease, color .16s ease; }
.env-btn:hover:not(:disabled) { border-color: #9ebac7; box-shadow: 0 3px 10px rgba(23, 107, 139, .12); }
.env-btn:active:not(:disabled) { transform: translateY(1px) scale(.985); box-shadow: inset 0 2px 4px rgba(0, 0, 0, .14); }
.env-btn:focus-visible { outline: 3px solid rgba(41, 126, 162, .22); outline-offset: 2px; }
.env-btn.primary { color: #fff; background: #176b8b; border-color: #176b8b; box-shadow: 0 3px 9px rgba(23, 107, 139, .2); }
.env-btn.primary:hover:not(:disabled) { background: #125c78; border-color: #125c78; box-shadow: 0 5px 13px rgba(23, 107, 139, .28); }
.env-btn.primary.is-busy { background: #125c78; border-color: #125c78; box-shadow: 0 0 0 3px rgba(41, 126, 162, .16), 0 4px 12px rgba(23, 107, 139, .22); }
.env-btn.primary.is-applied { background: #21844d; border-color: #21844d; box-shadow: 0 3px 10px rgba(33, 132, 77, .24); }
.env-btn:disabled { opacity: .92; cursor: wait; }
.env-btn-spinner { width: 13px; height: 13px; flex: 0 0 auto; border: 2px solid rgba(255, 255, 255, .42); border-top-color: #fff; border-radius: 50%; animation: env-btn-spin .72s linear infinite; }
@keyframes env-btn-spin { to { transform: rotate(360deg); } }
.env-input { width: 100%; min-height: 38px; padding: 8px 10px; color: #1d1d1f; background: #fff; border: 1px solid #d2d2d7; border-radius: 6px; box-sizing: border-box; }
.preset-panel { margin-top: 20px; padding: 17px; background: #fff; border: 1px solid #dce6ed; border-radius: 10px; }
.preset-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.preset-panel-heading strong { color: #303033; font-size: 13px; }
.preset-panel-heading p { margin: 5px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.5; }
.check-line { display: flex; align-items: center; gap: 7px; min-height: 38px; color: #515154; font-size: 12px; white-space: nowrap; }
.check-line input { accent-color: #176b8b; }
.preset-gallery { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.preset-card { min-width: 0; padding: 0; overflow: hidden; color: inherit; font: inherit; text-align: left; background: #fff; border: 1px solid #dce3e8; border-radius: 9px; box-shadow: 0 1px 2px rgba(30, 54, 74, .05); cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
.preset-card:hover:not(:disabled) { transform: translateY(-2px); border-color: #91b9c9; box-shadow: 0 7px 18px rgba(31, 73, 92, .12); }
.preset-card:focus-visible { outline: 3px solid rgba(41, 126, 162, .22); outline-offset: 2px; }
.preset-card:disabled { opacity: .72; cursor: wait; }
.preset-card.is-active { border-color: #297ea2; box-shadow: 0 0 0 2px rgba(41, 126, 162, .14), 0 7px 18px rgba(31, 73, 92, .1); }
.preset-card.is-custom { cursor: default; }
.preset-thumbnail { position: relative; display: block; height: 118px; overflow: hidden; background: var(--preview-sky); border-bottom: 1px solid rgba(27, 49, 65, .16); }
.preset-scene { position: absolute; inset: 0; overflow: hidden; filter: brightness(var(--preview-brightness)) saturate(var(--preview-saturation)) contrast(var(--preview-contrast)); }
.preset-sky { position: absolute; inset: 0 0 45%; background: linear-gradient(180deg, var(--preview-sky) 0%, var(--preview-horizon) 100%); }
.preset-horizon { position: absolute; left: 0; right: 0; top: 36%; height: 38%; opacity: var(--preview-fog-opacity); background: linear-gradient(180deg, transparent 0%, var(--preview-fog) 52%, transparent 100%); filter: blur(5px); }
.preset-floor { position: absolute; left: -10%; right: -10%; top: 45%; bottom: -8%; background: linear-gradient(180deg, color-mix(in srgb, var(--preview-floor) 76%, var(--preview-fill)) 0%, var(--preview-floor) 76%); clip-path: polygon(12% 0, 88% 0, 100% 100%, 0 100%); }
.preset-floor-grid { position: absolute; left: -8%; right: -8%; top: 45%; bottom: -8%; opacity: var(--preview-grid-opacity); background-image: linear-gradient(90deg, transparent 48%, var(--preview-grid) 49%, var(--preview-grid) 52%, transparent 53%), linear-gradient(0deg, transparent 46%, var(--preview-grid) 48%, var(--preview-grid) 52%, transparent 54%); background-size: 21px 100%, 100% 17px; clip-path: polygon(12% 0, 88% 0, 100% 100%, 0 100%); transform: perspective(150px) rotateX(19deg); transform-origin: center top; }
.preset-machine { position: absolute; width: 46px; height: 31px; background: linear-gradient(135deg, color-mix(in srgb, #fff 82%, var(--preview-fill)) 0%, color-mix(in srgb, #cbd2d8 72%, var(--preview-frame)) 100%); border: 1px solid color-mix(in srgb, var(--preview-frame) 65%, #1a2430); border-radius: 3px; box-shadow: 7px 8px 12px rgba(6, 14, 22, .34), inset -5px -5px 8px rgba(35, 55, 69, .16); }
.preset-machine::before { content: ''; position: absolute; left: 5px; top: 5px; width: 18px; height: 22px; background: linear-gradient(180deg, #17212a, #05090d); border: 1px solid color-mix(in srgb, var(--preview-frame) 65%, #fff); border-radius: 2px; }
.preset-machine::after { content: ''; position: absolute; right: 6px; top: 6px; width: 6px; height: 6px; background: var(--preview-key); border-radius: 50%; box-shadow: 0 0 var(--preview-glow-size) var(--preview-key), 0 11px 0 -1px var(--preview-frame); }
.preset-machine.is-back { left: 65%; bottom: 47px; transform: scale(.67); opacity: .82; }
.preset-machine.is-middle { left: 43%; bottom: 27px; transform: scale(.84); }
.preset-machine.is-front { left: 17%; bottom: 8px; width: 53px; height: 36px; }
.preset-light { position: absolute; top: -36px; right: -26px; width: 112px; height: 112px; opacity: var(--preview-bloom-opacity); background: radial-gradient(circle, var(--preview-key) 0%, transparent 68%); filter: blur(7px); }
.preset-vignette { position: absolute; inset: 0; box-shadow: inset 0 0 32px rgba(0, 7, 14, var(--preview-vignette-opacity)); }
.preset-selected { position: absolute; top: 8px; right: 8px; display: inline-flex; width: 23px; height: 23px; align-items: center; justify-content: center; color: #fff; background: #176b8b; border: 2px solid rgba(255,255,255,.9); border-radius: 50%; box-shadow: 0 2px 7px rgba(10, 42, 55, .28); font-size: 12px; }
.preset-card-copy { display: grid; gap: 7px; padding: 12px 13px 13px; }
.preset-card-copy > span:last-child { min-height: 38px; color: #6e6e73; font-size: 11px; line-height: 1.55; }
.preset-name-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.preset-name-row strong { min-width: 0; color: #27272a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-name-row small { flex: 0 0 auto; padding: 2px 6px; color: #27627a; background: #edf6f9; border-radius: 999px; font-size: 9px; font-weight: 600; }
.environment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.environment-card { padding: 18px; background: #fff; border: 1px solid #e1e6ea; border-radius: 10px; }
.environment-card h4 { margin: 0; color: #1d1d1f; font-size: 14px; }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.control-list { display: grid; gap: 14px; margin-top: 16px; }
.control-list > label { display: grid; grid-template-columns: minmax(120px, 1fr) 58px; align-items: center; gap: 8px 12px; color: #515154; font-size: 12px; font-weight: 500; }
.control-list > label > span { color: #1d1d1f; font-variant-numeric: tabular-nums; text-align: right; }
.control-list input[type="range"] { grid-column: 1 / -1; width: 100%; accent-color: #297ea2; }
.number-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.number-grid > label { display: flex; flex-direction: column; gap: 7px; color: #515154; font-size: 12px; font-weight: 500; }
.help { margin: 13px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.color-card { grid-column: 1 / -1; }
.color-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; margin-top: 16px; }
.color-grid > label { display: grid; grid-template-columns: minmax(56px, 1fr) 42px minmax(72px, auto); align-items: center; gap: 9px; padding: 9px 10px; background: #f8fafb; border: 1px solid #e4eaee; border-radius: 7px; color: #515154; font-size: 12px; }
.color-grid input[type="color"] { width: 42px; height: 30px; padding: 2px; background: #fff; border: 1px solid #cfd6dc; border-radius: 5px; cursor: pointer; }
.color-grid code { color: #3c4852; font-size: 11px; text-align: right; }
.switch { position: relative; display: inline-flex; width: 40px; height: 23px; }
.switch input { position: absolute; opacity: 0; }
.switch span { width: 100%; height: 100%; background: #c7c9cc; border-radius: 999px; transition: .2s ease; }
.switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 17px; height: 17px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: .2s ease; }
.switch input:checked + span { background: #24834f; }
.switch input:checked + span::after { transform: translateX(17px); }
.environment-message { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 9px 11px; color: #245d78; background: #edf8fc; border: 1px solid #c9e5ef; border-radius: 8px; font-size: 12px; line-height: 1.5; }
.environment-message-icon { display: inline-flex; width: 16px; height: 16px; flex: 0 0 auto; align-items: center; justify-content: center; color: currentColor; border: 1px solid currentColor; border-radius: 50%; font-size: 10px; font-weight: 700; line-height: 1; }
.environment-message.is-pending { color: #176b8b; background: #edf8fc; border-color: #b9dfea; }
.environment-message.is-pending .environment-message-icon { animation: env-message-pulse 1.1s ease-in-out infinite; }
.environment-message.is-success { color: #176b3a; background: #edf9f1; border-color: #bfe5ca; }
.environment-message.is-error { color: #a32828; background: #fff1f1; border-color: #efc5c5; }
.environment-message.is-info { color: #765315; background: #fff8e8; border-color: #f0dfae; }
@keyframes env-message-pulse { 50% { opacity: .42; transform: scale(.88); } }

@media (max-width: 1180px) {
    .environment-heading { flex-direction: column; }
    .environment-actions { width: 100%; min-width: 0; }
    .environment-grid,
    .color-grid { grid-template-columns: 1fr; }
    .preset-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .color-card { grid-column: auto; }
}
@media (max-width: 680px) {
    .preset-panel-heading { align-items: flex-start; flex-direction: column; }
    .preset-gallery { grid-template-columns: 1fr; }
}
</style>
