<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '颜色' },
  presets: {
    type: Array,
    default: () => ['transparent', '#ffffff', '#1d1d1f', '#59b2ee', '#45df9b', '#ffc45f', '#ff625f']
  }
})

const emit = defineEmits(['update:modelValue', 'commit'])

function byteToHex(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, '0')
}

function parseColor(value) {
  const source = String(value || '').trim()
  const hex = source.match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return {
        hex: `#${hex.slice(0, 3).split('').map(item => `${item}${item}`).join('')}`.toLowerCase(),
        alpha: hex.length === 4 ? parseInt(`${hex[3]}${hex[3]}`, 16) / 255 : null
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        hex: `#${hex.slice(0, 6)}`.toLowerCase(),
        alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : null
      }
    }
  }
  const rgb = source.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (rgb) {
    return {
      hex: `#${byteToHex(rgb[1])}${byteToHex(rgb[2])}${byteToHex(rgb[3])}`,
      alpha: rgb[4] === undefined ? null : Math.max(0, Math.min(1, Number(rgb[4])))
    }
  }
  return { hex: '#000000', alpha: source.toLowerCase() === 'transparent' ? 0 : null }
}

function formatAlpha(value) {
  return Number(Number(value).toFixed(2)).toString()
}

const parsedColor = computed(() => parseColor(props.modelValue))
const pickerColor = computed(() => parsedColor.value.hex)
const alphaLabel = computed(() => parsedColor.value.alpha === null
  ? ''
  : `透明度 ${Math.round(parsedColor.value.alpha * 100)}%`)

function colorWithPreservedAlpha(hex) {
  const alpha = parsedColor.value.alpha
  if (alpha === null || alpha >= 1) return hex.toLowerCase()
  const value = hex.replace('#', '')
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return alpha <= 0
    ? 'transparent'
    : `rgba(${red}, ${green}, ${blue}, ${formatAlpha(alpha)})`
}

function updateText(event) {
  emit('update:modelValue', event.target.value)
}

function updatePicker(event) {
  emit('update:modelValue', colorWithPreservedAlpha(event.target.value))
}

function selectPreset(value) {
  emit('update:modelValue', value)
  emit('commit')
}
</script>

<template>
  <div class="color-field">
    <div class="color-field-heading">
      <span>{{ label }}</span>
      <small v-if="alphaLabel">{{ alphaLabel }}</small>
    </div>
    <div class="color-field-control">
      <label class="color-picker-button" :title="`打开${label}调色盘`">
        <span class="color-picker-preview" :class="{ transparent: modelValue === 'transparent' }" :style="{ backgroundColor: modelValue }"></span>
        <input :aria-label="`${label}调色盘`" type="color" :value="pickerColor" @input="updatePicker" @change="$emit('commit')" />
      </label>
      <input class="color-value-input" :aria-label="`${label}颜色值`" :value="modelValue" placeholder="#RRGGBB 或 rgba(...)" @input="updateText" @change="$emit('commit')" />
    </div>
    <div class="color-preset-list" role="group" :aria-label="`${label}常用色`">
      <button
        v-for="color in presets"
        :key="color"
        type="button"
        :class="{ selected: color === modelValue, transparent: color === 'transparent' }"
        :style="{ backgroundColor: color }"
        :title="color === 'transparent' ? '透明' : color"
        :aria-label="`选择${label} ${color === 'transparent' ? '透明' : color}`"
        @click="selectPreset(color)"
      ></button>
    </div>
  </div>
</template>

<style scoped>
.color-field{display:grid;gap:6px}.color-field-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#515154;font-size:calc(12px * var(--admin-font-scale, 1))}.color-field-heading small{color:#8e8e93;font-size:calc(10px * var(--admin-font-scale, 1));font-variant-numeric:tabular-nums}.color-field-control{display:grid;grid-template-columns:42px minmax(0,1fr);gap:7px}.color-picker-button{position:relative;display:block!important;width:42px;height:36px;min-height:36px;overflow:hidden;border:1px solid #d8d8dd;border-radius:8px;background:#f5f5f7;cursor:pointer}.color-picker-button input{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;min-height:0!important;padding:0!important;border:0!important;opacity:0;cursor:pointer}.color-picker-preview{position:absolute;inset:4px;border:1px solid rgba(0,0,0,.12);border-radius:5px;box-shadow:inset 0 1px 1px rgba(255,255,255,.25)}.color-picker-preview.transparent,.color-preset-list button.transparent{background-color:#fff!important;background-image:linear-gradient(45deg,#d1d1d6 25%,transparent 25%),linear-gradient(-45deg,#d1d1d6 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d1d1d6 75%),linear-gradient(-45deg,transparent 75%,#d1d1d6 75%);background-position:0 0,0 4px,4px -4px,-4px 0;background-size:8px 8px}.color-value-input{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:6px 9px;border:1px solid #d8d8dd;border-radius:8px;outline:none;color:#1d1d1f;background:#fff;font:calc(12px * var(--admin-font-scale, 1))/1.35 "SFMono-Regular",Consolas,monospace}.color-value-input:focus{border-color:#86868b;box-shadow:0 0 0 3px rgba(0,0,0,.06)}.color-preset-list{display:flex;align-items:center;gap:6px;min-width:0;padding:1px}.color-preset-list button{position:relative;width:22px;height:22px;flex:0 0 22px;padding:0;border:2px solid #fff;border-radius:50%;outline:1px solid #d1d1d6;box-shadow:0 1px 2px rgba(0,0,0,.08);cursor:pointer;transition:transform .14s ease,outline-color .14s ease}.color-preset-list button:hover{transform:scale(1.12);outline-color:#6e6e73}.color-preset-list button.selected{outline:2px solid #1d1d1f;outline-offset:1px}
</style>
