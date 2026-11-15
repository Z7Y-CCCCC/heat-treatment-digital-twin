<script setup>
import { computed, onMounted, ref } from 'vue'
const props = defineProps({ proposal: { type: Object, required: true } })
const emit = defineEmits(['resolve'])
const dialog = ref(null)
const rows = computed(() => props.proposal.rows)
const geometry = computed(() => {
  const all = [...rows.value, ...props.proposal.originalRows], rail = props.proposal.layout.rails[0]
  const minX = Math.min(-rail.length / 2, ...all.map(r => r.x + r.minX)), maxX = Math.max(rail.length / 2, ...all.map(r => r.x + r.maxX))
  const minZ = Math.min(rail.offsetZ, ...all.map(r => r.z + r.minZ)), maxZ = Math.max(rail.offsetZ, ...all.map(r => r.z + r.maxZ))
  const scale = Math.min(900 / Math.max(maxX - minX, 1), 330 / Math.max(maxZ - minZ, 1))
  return { scale, x: x => 500 + (x - (maxX + minX) / 2) * scale, z: z => 215 + (z - (maxZ + minZ) / 2) * scale }
})
function rectangle(row) { const g = geometry.value; return { x: g.x(row.x + row.minX), y: g.z(row.z + row.minZ), width: Math.max(3, (row.maxX - row.minX) * g.scale), height: Math.max(3, (row.maxZ - row.minZ) * g.scale) } }
const moved = computed(() => rows.value.filter(r => { const old = props.proposal.originalRows.find(o => o.id === r.id); return old && (Math.abs(old.x - r.x) > 1e-6 || Math.abs(old.z - r.z) > 1e-6) }).length)
function keydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); emit('resolve', false) }
  if (event.key !== 'Tab') return
  const buttons = [...dialog.value.querySelectorAll('button')], at = buttons.indexOf(document.activeElement)
  if (event.shiftKey && at === 0) { event.preventDefault(); buttons.at(-1).focus() }
  if (!event.shiftKey && at === buttons.length - 1) { event.preventDefault(); buttons[0].focus() }
}
onMounted(() => dialog.value?.querySelector('button')?.focus())
</script>
<template>
  <Teleport to="body"><div class="arrangement-proposal-backdrop" @keydown="keydown"><section ref="dialog" class="arrangement-proposal" role="dialog" aria-modal="true" aria-labelledby="arrangement-proposal-title">
    <header><div><span>推荐方案 · 尚未应用</span><h3 id="arrangement-proposal-title">{{ proposal.lineName }} · 自动排布预览</h3></div><button type="button" aria-label="取消自动排布" @click="emit('resolve', false)">×</button></header>
    <div class="proposal-summary"><strong>{{ proposal.layout.lanes.length === 2 ? '双侧排布' : '单侧排布' }}</strong><span>{{ moved }} 台设备对接间距将调整</span><span>左右位置不变 · 由你手动排布</span><span v-if="proposal.layout.lanes.length === 2">两侧间距独立计算</span></div>
    <svg viewBox="0 0 1000 430" role="img" aria-label="自动排布前后对比，虚线为原位置，实色为推荐位置">
      <g class="proposal-original"><rect v-for="r in proposal.originalRows" :key="r.id" v-bind="rectangle(r)" rx="3" /></g>
      <g v-for="rail in proposal.layout.rails" :key="rail.id" class="proposal-rail"><line :x1="geometry.x(-rail.length/2)" :x2="geometry.x(rail.length/2)" :y1="geometry.z(rail.offsetZ)-3" :y2="geometry.z(rail.offsetZ)-3"/><line :x1="geometry.x(-rail.length/2)" :x2="geometry.x(rail.length/2)" :y1="geometry.z(rail.offsetZ)+3" :y2="geometry.z(rail.offsetZ)+3"/></g>
      <g v-for="r in rows" :key="r.id" :class="r.railId ? 'proposal-cart' : 'proposal-device'"><rect v-bind="rectangle(r)" rx="3"><title>{{ r.name || r.id }}</title></rect><text v-if="rectangle(r).width > 60" :x="rectangle(r).x+6" :y="rectangle(r).y+14">{{ r.name || r.id }}</text></g>
    </svg>
    <p class="proposal-note">虚线为原位置。只调整设备排与导轨的对接间距，不改变左右位置、设备顺序或线长。保留模型、原高度、朝向、缩放、料口和 PLC 工位编号；不拉长机构行程。应用后仍是草稿，可撤销或取消修改。</p>
    <footer><button type="button" class="btn" @click="emit('resolve', false)">保留原布局</button><button type="button" class="btn btn-primary" @click="emit('resolve', true)">应用到草稿</button></footer>
  </section></div></Teleport>
</template>
<style scoped>
.arrangement-proposal-backdrop{position:fixed;inset:0;z-index:18000;background:#25334a66;backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px}.arrangement-proposal{width:min(900px,calc(100vw - 40px));max-height:calc(100dvh - 40px);overflow-y:auto;background:#fff;border-radius:18px;box-shadow:0 24px 90px #14253d40;color:#263852}.arrangement-proposal header{display:flex;justify-content:space-between;align-items:center;padding:22px 26px;border-bottom:1px solid #edf0f4}.arrangement-proposal header span{font-size:11px;color:#8b96a6}.arrangement-proposal h3{font-size:17px;margin:7px 0 0}.arrangement-proposal header button{border:0;background:#f3f5f8;border-radius:8px;color:#7c8a9e;font-size:20px;width:30px;height:30px;cursor:pointer}.proposal-summary{display:flex;gap:16px;align-items:center;padding:17px 26px;font-size:12px}.proposal-summary span{color:#8793a4}.arrangement-proposal svg{display:block;width:calc(100% - 40px);margin:0 20px;background:#f1f5f9;border:1px solid #e5eaf0;border-radius:12px}.proposal-original rect{fill:none;stroke:#bac5d2;stroke-width:1;stroke-dasharray:5 4}.proposal-rail line{stroke:#ca9b50;stroke-width:2}.proposal-device rect{fill:#5e85ac;stroke:#416d98;stroke-width:1}.proposal-cart rect{fill:#c69b55;stroke:#a67c38;stroke-width:1}.arrangement-proposal text{font-size:11px;fill:#fff}.proposal-note{font-size:11px;color:#8793a5;line-height:1.8;margin:16px 26px}.arrangement-proposal footer{display:flex;justify-content:flex-end;gap:8px;padding:16px 26px;border-top:1px solid #edf0f4}.btn{border:1px solid #dfe5ed;background:#fff;color:#667b96;padding:9px 16px;border-radius:8px;font-size:12px;cursor:pointer}.btn-primary{background:#293f5e;color:#fff;border-color:#293f5e}@media(max-width:650px){.proposal-summary{flex-wrap:wrap;gap:8px}.arrangement-proposal header{padding:17px}.proposal-note{margin:13px 17px}.arrangement-proposal footer{padding:13px 17px}}
</style>
