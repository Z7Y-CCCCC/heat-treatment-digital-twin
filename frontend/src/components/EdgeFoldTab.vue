<script setup>
defineProps({ visible: Boolean, label: { type:String, required:true } })
const emit = defineEmits(['reveal'])
</script>

<template>
  <Transition name="edge-fold">
  <button v-show="visible" type="button" class="edge-fold-tab" :inert="!visible" :aria-hidden="!visible || undefined" :aria-label="label" :title="label" @click="emit('reveal', true)" @focus="emit('reveal', true)">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.5 4.5-3.5 3.5 3.5 3.5" /></svg>
  </button>
  </Transition>
</template>

<style scoped>
.edge-fold-tab{position:absolute;right:0;display:block;box-sizing:border-box;width:14px;height:42px;padding:0;border:0;border-left:1px solid #a1b1c491;border-bottom:1px solid #849bb85c;border-radius:0 0 0 6px;background:linear-gradient(135deg,#708298,#3e5066 46%,#354354);color:#dae7f8;box-shadow:-3px 3px 8px #0a172335;clip-path:polygon(8px 0,100% 0,100% 100%,0 100%,0 8px);cursor:pointer;pointer-events:auto}
.edge-fold-tab::before{content:"";position:absolute;top:0;left:0;width:8px;height:8px;clip-path:polygon(100% 0,100% 100%,0 100%);background:linear-gradient(135deg,#c0cddd,#8da1bb)}
.edge-fold-tab svg{position:absolute;right:0;top:17px;width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.edge-fold-tab:hover{background:linear-gradient(135deg,#879bb2,#4a607c 46%,#3d516b)}
.edge-fold-tab:focus-visible{outline:2px solid #d3e6ff;outline-offset:-3px}
.edge-fold-enter-active,.edge-fold-leave-active{transition:transform .24s cubic-bezier(.22,1,.36,1),opacity .24s ease}
.edge-fold-enter-from,.edge-fold-leave-to{transform:translateX(14px);opacity:0}
.edge-fold-leave-active{pointer-events:none}
@media(prefers-reduced-motion:reduce){.edge-fold-enter-active,.edge-fold-leave-active{transition:none}}
@media(forced-colors:active){.edge-fold-tab{background:ButtonFace;color:ButtonText;border:1px solid ButtonText}.edge-fold-tab::before{background:ButtonText}}
</style>
