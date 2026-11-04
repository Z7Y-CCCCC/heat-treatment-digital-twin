<script setup>
import { nextTick, ref } from 'vue'
defineProps({ modelValue: String, usernames: { type: Array, default: () => [] }, disabled: Boolean })
const emit = defineEmits(['update:modelValue', 'edited', 'selected'])
const open = ref(false)
const field = ref(null)
const input = ref(null)
const list = ref(null)

async function showChoices() {
    open.value = true
    await nextTick()
    list.value?.querySelector('[role="option"]')?.focus()
}
function closeChoices(focus = false) {
    open.value = false
    if (focus) input.value?.focus()
}
function selectUsername(username) {
    emit('update:modelValue', username)
    emit('edited')
    closeChoices()
    emit('selected')
}
function moveChoice(event, direction) {
    const options = [...list.value.querySelectorAll('[role="option"]')]
    const index = options.indexOf(event.target)
    options[(index + direction + options.length) % options.length]?.focus()
}
</script>

<template>
    <div ref="field" class="username-field" @focusout="!field.contains($event.relatedTarget) && closeChoices()" @keydown.esc.stop.prevent="closeChoices(true)">
        <input id="admin-unlock-username" ref="input" :value="modelValue" autocomplete="username" maxlength="32" required :disabled="disabled" placeholder="输入账号"
            :class="{ 'has-choices': usernames.length }" @input="emit('update:modelValue', $event.target.value.trim()); emit('edited'); closeChoices()"
            @keydown.down.prevent="usernames.length && showChoices()" />
        <button v-if="usernames.length" class="username-toggle" type="button" aria-label="选择本机已登录账号" aria-haspopup="listbox" :aria-expanded="open" aria-controls="remembered-usernames" :disabled="disabled"
            @click="open ? closeChoices(true) : showChoices()" @keydown.down.prevent="showChoices">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
        </button>
        <div v-if="open" id="remembered-usernames" ref="list" class="username-choices" role="listbox" aria-label="本机已登录账号"
            @keydown.down.prevent="moveChoice($event, 1)" @keydown.up.prevent="moveChoice($event, -1)">
            <button v-for="name in usernames" :key="name" type="button" role="option" :aria-selected="name === modelValue" @click="selectUsername(name)">{{ name }}</button>
        </div>
    </div>
</template>

<style scoped>
.username-field { position: relative; }
input { width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid #d0d5dd; border-radius: 9px; font: inherit; font-size: calc(14px * var(--admin-font-scale, 1)); color: #1d2939; background: #fff; }
input.has-choices { padding-right: 44px; }
input:focus { outline: 2px solid #84caff; outline-offset: 2px; }
button { font: inherit; cursor: pointer; }
button:disabled { opacity: .6; cursor: wait; }
.username-toggle { position: absolute; top: 5px; right: 5px; bottom: 5px; width: 34px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #667085; }
.username-toggle svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.username-choices { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 5px); max-height: 224px; overflow: auto; padding: 4px; border: 1px solid #dfe5ee; border-radius: 9px; background: #fff; box-shadow: 0 8px 20px #1018281a; }
.username-choices button { display: block; width: 100%; padding: 10px; border: 0; border-radius: 5px; background: transparent; color: #344054; text-align: left; overflow-wrap: anywhere; }
.username-choices button:hover, .username-choices button:focus-visible, .username-choices button[aria-selected="true"] { outline: none; background: #eff4fb; }
.username-toggle:focus-visible { outline: 2px solid #84caff; }
</style>
