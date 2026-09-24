<script setup>
defineProps({
  crumbs: { type: Array, default: () => [] }
})

const emit = defineEmits(['navigate'])
</script>

<template>
  <nav class="group-hierarchy-picker" aria-label="地图层级导航">
    <ol class="group-hierarchy-capsule">
      <li v-for="(crumb, index) in crumbs" :key="crumb.key" class="group-hierarchy-item">
        <span v-if="index" class="group-hierarchy-separator" aria-hidden="true">/</span>
        <button
          v-if="index < crumbs.length - 1"
          class="group-hierarchy-token"
          type="button"
          :aria-label="`返回${crumb.label}地图层级`"
          @click="emit('navigate', crumb)"
        >{{ crumb.label }}</button>
        <span v-else class="group-hierarchy-token current" aria-current="location">{{ crumb.label }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.group-hierarchy-picker{position:absolute;z-index:5;right:3%;top:12%;max-width:min(45vw,590px);font-family:var(--hud-font-text,'Inter','Noto Sans SC',sans-serif)}
.group-hierarchy-capsule{display:flex;align-items:center;justify-content:flex-end;gap:0;max-width:100%;min-height:30px;margin:0;padding:2px 7px;border:1px solid rgba(168,169,191,.17);border-radius:999px;background:linear-gradient(110deg,rgba(35,35,45,.42),rgba(29,29,39,.3));backdrop-filter:blur(10px);color:#dddde8;box-shadow:0 4px 15px rgba(8,8,14,.09),inset 0 1px 0 rgba(240,239,255,.035);list-style:none;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;opacity:.76;transition:opacity .18s ease,border-color .18s ease,background .18s ease}
.group-hierarchy-capsule:hover,.group-hierarchy-capsule:focus-within{opacity:1;border-color:rgba(168,169,191,.3);background:linear-gradient(110deg,rgba(35,35,45,.68),rgba(29,29,39,.54))}
.group-hierarchy-capsule::-webkit-scrollbar{display:none}
.group-hierarchy-item{display:flex;align-items:center;flex:0 0 auto;min-width:0}
.group-hierarchy-token{display:block;max-width:min(18vw,150px);padding:5px 4px;border:0;border-radius:999px;background:transparent;color:#9aa9c3;font-family:var(--hud-font-text,'Inter','Noto Sans SC',sans-serif);font-size:9px;font-weight:500;line-height:1.2;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;text-decoration:none;cursor:pointer;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
button.group-hierarchy-token:hover,button.group-hierarchy-token:focus-visible{color:#eef3ff;background:rgba(151,167,207,.12);outline:none}
button.group-hierarchy-token:focus-visible{box-shadow:0 0 0 2px rgba(155,157,244,.5)}
.group-hierarchy-token.current{color:#d4d5da;cursor:default}
.group-hierarchy-separator{padding:0 1px;color:#67738d;font-size:9px;user-select:none}
@media(max-width:900px){.group-hierarchy-picker{top:12.5%;max-width:62vw}.group-hierarchy-capsule{min-height:28px;padding:2px 6px}.group-hierarchy-token{max-width:16vw;padding:5px 3px;font-size:8px}}
</style>
