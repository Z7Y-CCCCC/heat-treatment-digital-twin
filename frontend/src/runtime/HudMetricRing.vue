<script setup>
import { computed } from 'vue'
const props = defineProps({ value: { type: Number, default: null }, label: { type: String, default: '' } })
const percent = computed(() => Math.max(0, Math.min(100, props.value ?? 0)))
const formattedValue = computed(() => props.value === null ? '—' : props.value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }))
</script>
<template>
        <div class="hud-module-ring" :aria-label="`${label} ${value === null ? '暂无数据' : formattedValue + '%'}`">
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-halo" cx="60" cy="60" r="53"/><g class="ring-ticks"><line v-for="tick in 48" :key="tick" x1="60" :y1="tick % 6 === 1 ? 1.5 : 3.5" x2="60" :y2="tick % 6 === 1 ? 7.5 : 6.5" :class="{'ring-tick-major':tick % 6 === 1}" :transform="`rotate(${(tick - 1) * 7.5} 60 60)`"/></g><circle class="ring-track" cx="60" cy="60" r="44"/><circle class="ring-progress" cx="60" cy="60" r="44" pathLength="100" :stroke-dasharray="`${percent} 100`" transform="rotate(-90 60 60)"/><circle class="ring-inner" cx="60" cy="60" r="36"/></svg>
          <span class="hud-module-ring-copy"><strong>{{ formattedValue }}<small v-if="value !== null">%</small></strong><em v-if="label">{{ label }}</em></span>
        </div>
</template>
