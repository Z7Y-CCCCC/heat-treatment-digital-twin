<script setup>
defineProps({ modelValue: { type: Array, default: () => [0, 0, 0] }, label: { type: String, default: '' }, step: { type: Number, default: 0.1 }, unit: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue'])
function update(value, index, current) {
    const next = [...current]
    next[index] = value === '' ? 0 : Number(value)
    emit('update:modelValue', next)
}
</script>

<template>
    <fieldset class="inspection-vector">
        <legend>{{ label }}<small v-if="unit"> · {{ unit }}</small></legend>
        <label v-for="(axis, index) in ['X', 'Y', 'Z']" :key="axis">
            <span>{{ axis }}</span>
            <input type="number" :step="step" :aria-label="`${label} ${axis}`" :value="modelValue[index]" @input="update($event.target.value, index, modelValue)" />
        </label>
    </fieldset>
</template>

<style scoped>
.inspection-vector { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 0; margin: 0; min-width: 0; border: 0; }
legend { padding: 0; margin-bottom: 6px; color: #475467; font-size: 13px; }
legend small { color: #6b7f8f; font-size: inherit; }
label { display: flex; align-items: center; border: 1px solid #d5dfe6; border-radius: 6px; background: #fff; min-width: 0; overflow: hidden; }
span { color: #67808e; background: #f2f6f8; padding: 8px; font-size: 12px; }
input { width: 100%; min-width: 0; border: 0; padding: 7px 4px; color: #223d4c; background: transparent; font-size: 14px; outline: none; }
label:focus-within { outline: 2px solid #45b4c8; outline-offset: 1px; }
</style>
