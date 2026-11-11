<script setup>
const props = defineProps({ enabled:Boolean, available:Boolean, pending:Boolean })
const emit = defineEmits(['toggle'])
</script>
<template>
  <button type="button" class="shell-transparency-button" :class="{'is-active':enabled}" :disabled="!available || pending" :aria-pressed="enabled" :aria-busy="pending"
    :aria-label="enabled ? '恢复外壳' : '外壳透明'" :title="!available ? '当前视角未配置可透视外壳' : enabled ? '恢复外壳' : '外壳透明 · 查看内部动作'" @click="emit('toggle')" @dblclick.stop>
    <svg v-if="!enabled" viewBox="0 0 32 32" aria-hidden="true" class="shell-icon-solid"><path d="m16 3 12 7v13l-12 7L4 23V10L16 3Zm-12 7 12 7 12-7M16 17v13"/></svg>
    <svg v-else viewBox="0 0 40 40" aria-hidden="true" class="shell-icon-inside">
      <path class="shell-wire" d="m20 2 16 9v18l-16 9-16-9V11L20 2Zm-16 9 16 9 16-9M20 20v18M20 2v18M4 29l16-9 16 9"/>
      <g class="shell-gears"><path d="m14 16 2-1 2 2 2-1 1 2-1 2 1 2-2 2-2-1-2 1-2-2-2 1-1-2 1-2-1-2 2-2 2 1Z"/><ellipse cx="15" cy="21" rx="3.3" ry="4.1" transform="rotate(-25 15 21)"/>
        <path d="m24 10 2 1 1-1 2 2-1 2 1 1 2 1v3l-2 1-1 2-2-1-1 1-2-2 1-2-1-2-2-1v-2l2-1 1-2Z"/><ellipse cx="26" cy="16" rx="2.5" ry="3.2" transform="rotate(-25 26 16)"/>
        <path d="m23 25 5-3 5 3v6l-5 3-5-3v-6Zm0 0 5 3 5-3M28 28v6M10 14v-4l5-3 2 1v2l-5 3v2"/>
      </g>
    </svg>
  </button>
</template>
<style scoped>
.shell-transparency-button{display:grid;place-items:center;width:58px;height:58px;padding:7px;border:1px solid #b4dcffb0;border-radius:17px;background:linear-gradient(145deg,#398dedf5,#245bb9f5);color:#eff9ff;cursor:pointer;box-shadow:inset 0 1px 0 #f2fcff3b,0 7px 24px #143c7566,0 0 0 4px #6bb6ff12;transition:background .16s,border-color .16s,color .16s,transform .16s}
.shell-transparency-button:hover:not(:disabled){color:#fff;border-color:#def5ff;background:linear-gradient(145deg,#50a6ff,#2d6dd4)}
.shell-transparency-button.is-active{color:#effff9;border-color:#a4f2dcd9;background:linear-gradient(145deg,#20bb9cf5,#088576f5);box-shadow:inset 0 1px 0 #e0fff647,0 7px 24px #075e5166,0 0 0 4px #61e9bf18}
.shell-transparency-button.is-active:hover:not(:disabled){background:linear-gradient(145deg,#36d0af,#0b9e89)}
.shell-transparency-button:focus-visible{outline:2px solid #a6d7c1;outline-offset:2px}
.shell-transparency-button:disabled{opacity:.42;cursor:not-allowed}.shell-transparency-button[aria-busy=true]{cursor:wait;opacity:.65}
.shell-transparency-button svg{width:35px;height:35px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.65}
.shell-transparency-button .shell-icon-inside{width:42px;height:42px;stroke-width:1.1}.shell-wire{stroke-dasharray:2.5 2;opacity:.85}.shell-gears{fill:#138b7c}
@media(prefers-reduced-motion:reduce){.shell-transparency-button{transition:none}}
</style>
