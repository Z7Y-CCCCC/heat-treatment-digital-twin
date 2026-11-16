<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  workshops: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] },
  devices: { type: Array, default: () => [] }, workshopId: String, lineId: String, deviceId: String,
  layer: { type: String, default: 'workshop' }, view: { type: String, default: 'plan' },
  busy: Boolean, dirty: Boolean, canSave: Boolean, canViewLines: Boolean, canViewDevices: Boolean, canUndo: Boolean, canCreateLine: Boolean, canDeleteLine: Boolean
})
const emit = defineEmits(['workshop', 'line', 'device', 'overview', 'view', 'save', 'discard', 'undo', 'create-line', 'edit-line', 'delete-line'])
const treeOpen = ref(false), query = ref('')
const workshop = computed(() => props.workshops.find(w => w.id === props.workshopId))
const line = computed(() => props.lines.find(l => l.id === props.lineId))
const localLines = computed(() => props.lines.filter(l => l.workshop_id === props.workshopId))
const localDevices = computed(() => props.devices.filter(d => d.arrangementWorkshopId === props.workshopId))
const matches = item => !query.value.trim() || String(item.name || item.id).toLowerCase().includes(query.value.trim().toLowerCase())
const visibleLines = computed(() => localLines.value.filter(l => matches(l) || localDevices.value.some(d => d.arrangementLineId === l.id && matches(d))))
const lineDevices = id => localDevices.value.filter(d => d.arrangementLineId === id && matches(d))
const unassigned = computed(() => localDevices.value.filter(d => !d.arrangementLineId && matches(d)))
function choose(event, value) { if (props.busy) return; treeOpen.value = false; emit(event, value) }
</script>

<template>
  <section class="workshop-arrangement" aria-label="车间编排" data-testid="workshop-arrangement">
    <header class="arrangement-header">
      <div class="arrangement-heading"><span class="arrangement-mark" aria-hidden="true">▧</span><div><h2>车间编排</h2><p>从整条产线到每台设备，在一处完成布局。</p></div></div>
      <div class="arrangement-commands">
        <span class="arrangement-save-state" :class="{ dirty }" role="status">{{ busy ? '正在处理…' : dirty ? '有未保存修改' : '布局已保存' }}</span>
        <button v-if="canUndo" class="btn btn-sm" type="button" :disabled="busy" @click="emit('undo')">撤销排布</button>
        <button class="btn btn-sm" type="button" :disabled="busy || !dirty" @click="emit('discard')">取消修改</button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="busy || !dirty || !canSave" @click="emit('save')">{{ busy ? '处理中…' : '保存布局' }}</button>
      </div>
    </header>
    <div class="arrangement-context">
      <button class="arrangement-tree-toggle btn btn-sm" type="button" :aria-expanded="treeOpen" @click="treeOpen = !treeOpen">对象列表</button>
      <label class="arrangement-workshop-select"><span>当前车间</span><select :value="workshopId" aria-label="编排车间" :disabled="busy" @change="choose('workshop', $event.target.value)"><option v-for="w in workshops" :key="w.id" :value="w.id">{{ w.name }}</option></select></label>
      <nav class="arrangement-breadcrumb" aria-label="编排层级"><button type="button" :aria-current="layer === 'workshop' ? 'page' : undefined" :disabled="busy" @click="choose('overview')">车间总览</button><template v-if="layer === 'line'"><span aria-hidden="true">/</span><strong>{{ line?.name || '产线' }}</strong></template></nav>
      <div class="arrangement-view-switch" role="group" aria-label="编排视图"><button type="button" :aria-pressed="view === 'plan'" :disabled="busy" @click="choose('view', 'plan')">俯视排布</button><button v-if="canViewDevices" type="button" :aria-pressed="view === 'three'" :disabled="busy" @click="choose('view', 'three')">三维效果</button></div>
    </div>
    <div class="arrangement-body">
      <button v-if="treeOpen" type="button" class="arrangement-tree-scrim" aria-label="收起对象列表" @click="treeOpen = false"></button>
      <aside class="arrangement-tree" :class="{ open: treeOpen }" aria-label="编排对象">
        <div class="arrangement-tree-title"><strong>对象列表</strong></div>
        <input v-model="query" class="arrangement-search" aria-label="搜索编排对象" placeholder="搜索产线、设备" />
        <button class="arrangement-workshop-row" type="button" :class="{ selected: layer === 'workshop' }" :disabled="busy" @click="choose('overview')"><span aria-hidden="true">▦</span><strong>{{ workshop?.name || '尚无车间' }}</strong><small>总览</small></button>
        <div v-if="canViewLines" class="arrangement-object-list">
          <div class="arrangement-lines-title">
            <strong>产线 <span>{{ localLines.length }}</span></strong>
            <button v-if="canCreateLine" type="button" class="arrangement-add-line" aria-label="新增产线" title="新增产线" :disabled="busy" @click="emit('create-line')"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg></button>
          </div>
          <div v-for="l in visibleLines" :key="l.id" class="arrangement-line-group">
            <div class="arrangement-line-header" :class="{ selected: layer === 'line' && lineId === l.id && !deviceId }">
              <button type="button" class="arrangement-line-row" :class="{ selected: layer === 'line' && lineId === l.id && !deviceId }" :disabled="busy" @click="choose('line', l.id)"><span class="arrangement-line-symbol" aria-hidden="true"></span><span :title="l.name">{{ l.name }}</span></button>
              <div v-if="layer === 'line' && lineId === l.id && (canCreateLine || canDeleteLine)" class="arrangement-line-actions">
                <button v-if="canCreateLine" type="button" :aria-label="`编辑产线 ${l.name}`" :title="`编辑产线 ${l.name}`" :disabled="busy" @click.stop="emit('edit-line', l.id)"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></svg></button>
                <button v-if="canDeleteLine" type="button" class="arrangement-delete-line" :aria-label="`删除产线 ${l.name}`" :title="`删除产线 ${l.name}`" :disabled="busy" @click.stop="emit('delete-line', l.id)"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></button>
              </div>
              <small class="arrangement-line-count">{{ lineDevices(l.id).length }}</small>
            </div>
            <div v-if="canViewDevices && lineId === l.id && layer === 'line'" class="arrangement-device-children">
              <button v-for="d in lineDevices(l.id)" :key="d.id" type="button" :class="{ selected: deviceId === d.id }" :disabled="busy" @click="choose('device', d.id)"><i :class="{ cart: d.arrangementCart }" aria-hidden="true"></i><span>{{ d.name || d.id }}</span><small v-if="d.arrangementCart">小车</small></button>
            </div>
          </div>
          <p v-if="!visibleLines.length" class="arrangement-empty">{{ query ? '没有匹配的对象' : '当前车间尚无产线' }}</p>
        </div>
        <div v-if="canViewDevices && unassigned.length" class="arrangement-pool"><h3>车间级／待分配设备 <span>{{ unassigned.length }}</span></h3><button v-for="d in unassigned" :key="d.id" type="button" :class="{ selected: deviceId === d.id }" :disabled="busy" @click="choose('device', d.id)">{{ d.name || d.id }}</button></div>
        <footer class="arrangement-tree-note">选产线看内部排布<br>选设备看空间设置</footer>
      </aside>
      <main class="arrangement-canvas" :data-arrangement-layer="layer" :data-arrangement-view="view">
        <div v-show="view === 'three'" class="arrangement-view-panel"><slot name="three" /></div>
        <div v-show="view === 'plan' && layer === 'line'" class="arrangement-view-panel"><slot name="line" /></div>
        <div v-show="view === 'plan' && layer === 'workshop'" class="arrangement-view-panel"><slot name="workshop" /></div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.workshop-arrangement{height:calc(100dvh - 108px);min-height:480px;display:flex;flex-direction:column;overflow:hidden;background:#f7f8fa;border:1px solid #e3e6eb;border-radius:18px;box-shadow:0 8px 32px #23354d08;color:#243047}
.arrangement-header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 24px;background:white;border-bottom:1px solid #e9ecf1;flex:none}.arrangement-heading{display:flex;align-items:center;gap:12px;min-width:0}.arrangement-mark{display:grid;place-items:center;width:39px;height:39px;border-radius:12px;background:#eef2f8;color:#49617e;font-size:24px}.arrangement-heading h2{font-size:19px;letter-spacing:.02em;margin:0}.arrangement-heading p{font-size:12px;color:#7d8796;margin:5px 0 0}.arrangement-commands{display:flex;align-items:center;gap:8px}.arrangement-save-state{font-size:11px;color:#8993a0;margin-right:8px;white-space:nowrap}.arrangement-save-state.dirty{color:#a46c25}.arrangement-context{display:flex;align-items:center;gap:22px;padding:11px 24px;background:#fff;flex:none;border-bottom:1px solid #e7eaf0}.arrangement-workshop-select{display:flex;align-items:center;gap:9px;min-width:0;font-size:11px;color:#8a929e}.arrangement-workshop-select select{border:0;background:#f2f4f7;padding:7px 12px;border-radius:7px;font-size:12px;color:#334155;max-width:190px}.arrangement-breadcrumb{display:flex;gap:11px;align-items:center;font-size:12px;min-width:0}.arrangement-breadcrumb button{background:none;border:0;color:#798494;cursor:pointer;padding:4px 0}.arrangement-breadcrumb button[aria-current]{color:#253852;font-weight:600}.arrangement-breadcrumb strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.arrangement-view-switch{display:flex;padding:3px;background:#f0f2f5;border-radius:8px;margin-left:auto;flex:none}.arrangement-view-switch button{border:0;border-radius:6px;background:transparent;font-size:12px;padding:6px 13px;color:#7b8594;cursor:pointer}.arrangement-view-switch button[aria-pressed=true]{background:white;color:#263852;box-shadow:0 1px 4px #1e293b14}.arrangement-body{display:grid;grid-template-columns:214px minmax(0,1fr);min-height:0;flex:1;position:relative}.arrangement-tree{display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;border-right:1px solid #e3e7ed;background:#fbfcfd;padding:18px 12px}.arrangement-tree-title{display:flex;justify-content:space-between;align-items:center;padding:0 5px;font-size:12px}.arrangement-search{width:100%;min-width:0;box-sizing:border-box;border:1px solid #e6eaf0;border-radius:7px;background:white;padding:8px 10px;font-size:11px}.arrangement-workshop-row,.arrangement-line-row,.arrangement-device-children button,.arrangement-pool button{display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:7px;background:transparent;color:#687486;cursor:pointer;text-align:left;padding:10px;font-size:12px}.arrangement-workshop-row strong,.arrangement-line-row>span:nth-child(2),.arrangement-device-children span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.arrangement-workshop-row small,.arrangement-line-row small,.arrangement-device-children small{margin-left:auto;font-size:10px;color:#929caa;flex:none}.selected{background:#eaf0f8!important;color:#2b4d78!important}.arrangement-line-symbol{width:10px;height:7px;border-top:2px solid #8198b3;border-bottom:2px solid #8198b3;flex:none}.arrangement-device-children{margin:2px 0 9px 16px;border-left:1px solid #e2e7ee;padding-left:6px}.arrangement-device-children button{padding:8px;font-size:11px}.arrangement-device-children i{width:6px;height:6px;background:#a3b4c7;border-radius:2px;flex:none}.arrangement-device-children i.cart{background:#c49c60}.arrangement-empty{padding:12px 5px;font-size:11px;color:#939dab}.arrangement-pool{border-top:1px solid #e9edf2;padding-top:10px}.arrangement-pool h3{font-size:10px;color:#8792a1;font-weight:500;padding:0 8px}.arrangement-pool h3 span{float:right}.arrangement-tree-note{margin-top:auto;padding:14px 8px 0;color:#9aa4b1;font-size:10px;line-height:1.8}.arrangement-view-panel{height:100%;min-width:0;overflow:hidden}.arrangement-canvas{position:relative;min-width:0;min-height:0;overflow:hidden}.arrangement-tree-toggle,.arrangement-tree-scrim{display:none}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #6388b9;outline-offset:2px}
.arrangement-lines-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 5px 7px;font-size:11px;color:#687486}.arrangement-lines-title strong{display:flex;align-items:center;gap:6px;font-weight:600}.arrangement-lines-title span{font-size:10px;color:#919ba8;font-weight:400}.arrangement-add-line{border:1px solid #e1e7ef;border-radius:6px;background:#fff;color:#667d99;cursor:pointer;display:grid;place-items:center;width:26px;height:26px;padding:4px}.arrangement-add-line svg,.arrangement-line-actions svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.arrangement-add-line:hover:not(:disabled){background:#eef3fa;color:#2b4d78}.arrangement-line-header{display:flex;align-items:center;gap:3px;border-radius:7px;padding-right:6px;min-width:0}.arrangement-line-header .arrangement-line-row{flex:1;min-width:0;width:auto;padding-right:3px}.arrangement-line-actions{display:flex;flex:none;align-items:center;gap:2px;padding:0}.arrangement-line-actions button{border:0;background:none;cursor:pointer;display:grid;place-items:center;flex:none;width:24px;height:26px;padding:4px;border-radius:5px;color:#667d99}.arrangement-line-actions button:hover:not(:disabled){background:#dce6f3;color:#2b4d78}.arrangement-line-actions .arrangement-delete-line:hover:not(:disabled){background:#fbe8e8;color:#b34747}.arrangement-line-count{flex:none;font-size:10px;color:#929caa;min-width:10px;text-align:right}
@media(max-width:1050px){.arrangement-body{grid-template-columns:180px minmax(0,1fr)}.arrangement-header{padding:15px 17px}.arrangement-context{padding:10px 17px;gap:12px}.arrangement-heading p{display:none}}
@media(max-width:760px){.workshop-arrangement{height:calc(100dvh - 90px);min-height:400px;border-radius:12px}.arrangement-header{padding:12px}.arrangement-mark,.arrangement-save-state,.arrangement-workshop-select>span{display:none}.arrangement-heading h2{font-size:16px}.arrangement-context{padding:9px 12px;gap:10px;flex-wrap:wrap}.arrangement-workshop-select select{max-width:140px}.arrangement-tree-toggle{display:block}.arrangement-breadcrumb{order:4;width:100%;font-size:11px}.arrangement-view-switch button{font-size:11px;padding:6px 9px}.arrangement-body{display:block}.arrangement-tree{position:absolute;top:0;bottom:0;left:0;width:220px;z-index:20;transform:translateX(-100%);transition:transform .18s ease;box-shadow:8px 0 30px #26354c18}.arrangement-tree.open{transform:translateX(0)}.arrangement-tree-scrim{display:block;position:absolute;inset:0;border:0;background:#26354c30;z-index:19}.arrangement-canvas{height:100%}}
</style>
