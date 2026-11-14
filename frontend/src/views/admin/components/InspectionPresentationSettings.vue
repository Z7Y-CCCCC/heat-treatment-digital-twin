<script setup>
import { computed } from 'vue'
import InspectionCameraFields from './InspectionCameraFields.vue'
const props = defineProps({ draft: { type: Object, required: true }, nodes: { type: Array, default: () => [] }, section: String, disabled: Boolean })
const emit = defineEmits(['change', 'command', 'capture'])
const update = (key, value) => emit('change', { [key]: value })
const field = (key, name, value) => update(key, { ...props.draft[key], [name]: value,
 ...(name === 'node_paths' ? {node_path:''} : name === 'node_names' ? {node_name:''} : {}) })
const meshNodes = computed(() => props.nodes.filter(node => node.meshCount > 0))
const stages = [{ key: 'solid', name: '完整设备' }, { key: 'xray', name: '外壳透视' }, { key: 'exploded', name: '全部拆解' }]
</script>
<template>
 <div class="presentation-settings">
  <fieldset :disabled="disabled">
   <template v-if="section === 'shell'">
    <section class="settings-card"><h4>外壳显示</h4>
     <label>退场方式<select :value="draft.shell.transition" @change="field('shell','transition',$event.target.value)"><option value="clip">剖切退场</option><option value="fade">淡出</option><option value="hide">直接隐藏</option></select></label>
     <div class="field-pair"><label>退场时长 / 秒<input type="number" min="0" max="5" step=".1" :value="draft.shell_duration" @change="update('shell_duration',Number($event.target.value))"></label><label>透视不透明度<input type="number" min="0" max="1" step=".05" :value="draft.shell.opacity" @change="field('shell','opacity',Number($event.target.value))"></label></div>
     <div v-if="draft.shell.transition === 'clip'" class="field-pair"><label>剖切轴<select :value="draft.shell.axis" @change="field('shell','axis',$event.target.value)"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label><label>方向<select :value="draft.shell.direction" @change="field('shell','direction',Number($event.target.value))"><option :value="1">正向</option><option :value="-1">反向</option></select></label></div>
     <label class="check"><input type="checkbox" :checked="draft.shell.wireframe" @change="field('shell','wireframe',$event.target.checked)">透视时显示线框</label>
    </section>
    <section class="settings-card"><h4>动作时序</h4><div class="field-pair"><label>部件运动 / 秒<input type="number" min=".05" max="10" step=".05" :value="draft.animation_duration" @change="update('animation_duration',Number($event.target.value))"></label><label>依次间隔 / 秒<input type="number" min="0" max="1" step=".01" :value="draft.stagger" @change="update('stagger',Number($event.target.value))"></label></div><label>缓动<select :value="draft.easing" @change="update('easing',$event.target.value)"><option value="smoothstep">平滑起止</option><option value="cubic">柔和加减速</option><option value="linear">匀速</option></select></label></section>
    <details class="settings-card"><summary>外壳节点 <span>{{ draft.shell.node_paths?.length || 0 }} 个</span></summary><label>选择外壳网格<select multiple size="7" aria-label="外壳节点选择" :value="draft.shell.node_paths" @change="field('shell','node_paths',[...$event.target.selectedOptions].map(o=>o.value))"><option v-for="node in meshNodes" :key="node.path" :value="node.path">{{ node.displayName || node.name }}</option></select></label><label>按节点名补充<textarea rows="3" :value="draft.shell.node_names.join('\n')" @change="field('shell','node_names',$event.target.value.split(/\r?\n/).filter(Boolean))" /></label></details>
   </template>
   <template v-else-if="section === 'camera'">
    <section class="settings-card"><h4>空间标签</h4><label class="check"><input type="checkbox" :checked="draft.labels.enabled" @change="field('labels','enabled',$event.target.checked)">默认显示部件名称</label><label class="check"><input type="checkbox" :checked="draft.labels.leader_lines" @change="field('labels','leader_lines',$event.target.checked)">显示标签引线</label></section>
    <details v-for="(stage,index) in stages" :key="stage.key" class="settings-card camera-card" :open="index === 0"><summary>{{ stage.name }}<span>镜头</span></summary><button type="button" class="preview-camera" @click="emit('command',{command:'stage',stage:stage.key})">预览此镜头</button><InspectionCameraFields permission-page="disassembly-layout" :model-value="draft[stage.key].camera" :label="stage.name" @update:model-value="field(stage.key,'camera',$event)" @capture="emit('capture',stage.key)"/><label>镜头过渡 / 秒<input type="number" min=".05" max="10" step=".1" :value="draft[stage.key].transition_seconds" @change="field(stage.key,'transition_seconds',Number($event.target.value))"></label><details class="advanced"><summary>关联大屏视角</summary><input :value="draft[stage.key].view_id" placeholder="视角 ID（可选）" @change="field(stage.key,'view_id',$event.target.value)"></details></details>
   </template>
  </fieldset>
 </div>
</template>
<style scoped>
.presentation-settings{padding:16px;max-height:650px;overflow:auto;font-size:13px;color:#33485d}.presentation-settings *{box-sizing:border-box}fieldset{border:0;margin:0;padding:0;display:grid;gap:14px;min-width:0}.settings-card{display:grid;gap:15px;padding:17px;background:#fff;border:1px solid #e1e8ef;border-radius:12px;box-shadow:0 2px 6px #263c5104}h4{margin:0;color:#273e53;font-size:14px}label{display:grid;gap:7px;color:#65798d;font-size:12px;min-width:0}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}input:not([type=checkbox]),select,textarea{width:100%;min-width:0;border:1px solid #d6e0e9;border-radius:7px;padding:9px;background:#fff;color:#344d63;font:inherit}input[type=checkbox]{accent-color:#237b97}.check{display:flex;align-items:center;gap:8px}summary{cursor:pointer;font-weight:600;color:#354d63;font-size:13px;list-style:none}summary::before{content:'›';display:inline-block;margin-right:8px;color:#7991a6}details[open]>summary::before{transform:rotate(90deg)}summary span{float:right;color:#8ca0b1;font-size:11px;font-weight:400}.settings-card[open]>summary{margin-bottom:16px}.settings-card[open]>label,.settings-card[open]>:deep(.camera-fields){margin-bottom:14px}.preview-camera{width:100%;padding:8px;margin-bottom:16px;border:1px solid #cde0ea;border-radius:7px;background:#eff7fa;color:#28708e;cursor:pointer}.advanced{margin-top:12px}.advanced input{margin-top:12px}input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #418fac;outline-offset:2px}.presentation-settings :deep(.camera-fields){display:grid;grid-template-columns:1fr;gap:10px}.presentation-settings :deep(input){min-width:0;max-width:100%}
</style>
