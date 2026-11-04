<script setup>
const props=defineProps({binding:Object,devices:Array,disabled:Boolean})
const emit=defineEmits(['change'])
function scope(value){if(props.disabled)return;props.binding.deviceScope=value;emit('change')}
function toggle(id,checked){const ids=new Set(props.binding.rotationDeviceIds || []);checked?ids.add(id):ids.delete(id);props.binding.rotationDeviceIds=[...ids].slice(0,100);emit('change')}
function interval(key,event){props.binding[key]=Math.max(key==='refreshMs'?(['http_api','dataset'].includes(props.binding.mode)?250:1000):2000,Math.min(3600000,Math.round(Number(event.target.value || (key==='refreshMs'?5:10))*1000)));emit('change')}
</script>
<template>
 <section class="playback-editor" aria-label="设备数据播放">
  <div class="playback-scopes" role="group" aria-label="设备数据范围"><button v-for="item in [{id:'current',label:'跟随视角'},{id:'fixed',label:'固定设备'},{id:'rotation',label:'设备轮播'},...(binding.mode==='plc'?[]:[{id:'global',label:'全局数据'}])]" :key="item.id" type="button" :aria-pressed="(binding.deviceScope || 'current')===item.id" :class="{active:(binding.deviceScope || 'current')===item.id}" :disabled="disabled" @click="scope(item.id)">{{item.label}}</button></div>
  <label v-if="binding.deviceScope==='fixed'">设备<select v-model="binding.deviceId" aria-label="固定数据设备" :disabled="disabled" @change="emit('change')"><option value="">请选择</option><option v-for="d in devices" :key="d.id" :value="String(d.id)">{{d.name}}</option></select></label>
  <div class="playback-intervals"><label>刷新（秒）<input :value="(binding.refreshMs || 5000)/1000" type="number" :min="['http_api','dataset'].includes(binding.mode)?0.25:1" step="0.25" max="3600" aria-label="组件数据刷新秒数" :disabled="disabled" @change="interval('refreshMs',$event)" /></label><label v-if="!['fixed','global'].includes(binding.deviceScope)">切换（秒）<input :value="(binding.rotationIntervalMs || 10000)/1000" type="number" min="2" max="3600" aria-label="设备轮播秒数" :disabled="disabled" @change="interval('rotationIntervalMs',$event)" /></label></div>
  <details v-if="!['fixed','global'].includes(binding.deviceScope)"><summary>轮播设备 <span>{{binding.rotationDeviceIds?.length || '当前范围'}}</span></summary><div class="playback-device-list"><label v-for="d in devices" :key="d.id"><input type="checkbox" :checked="binding.rotationDeviceIds?.includes(String(d.id))" :disabled="disabled" @change="toggle(String(d.id),$event.target.checked)" />{{d.name}}</label></div></details>
  <small v-if="binding.mode==='plc' || binding.mode==='runtime'">PLC 与设备数值跟随实时帧；刷新周期不阻塞数值更新。</small>
  <small v-if="binding.deviceScope!=='global'">设备视角锁定当前设备；其他视角按上述范围显示。</small>
 </section>
</template>
<style scoped>
.playback-editor{padding:12px;border:1px solid #e0e6f0;border-radius:9px;display:grid;gap:11px;font-size:calc(12px * var(--admin-font-scale, 1));color:#718098;background:#fafbfd}.playback-scopes{display:flex;background:#eef1f6;padding:3px;border-radius:7px;gap:2px}.playback-scopes button{flex:1;border:0;background:none;border-radius:5px;padding:7px 3px;color:#8290a5;font:inherit;cursor:pointer}.playback-scopes button.active{background:#fff;color:#3263c8;box-shadow:0 1px 4px #26395212}.playback-editor label{display:grid;gap:6px}.playback-editor select,.playback-editor input[type=number]{min-width:0;width:100%;box-sizing:border-box;padding:7px;border:1px solid #d9e1ec;border-radius:6px;color:#42536c;background:white;font:inherit}.playback-intervals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.playback-editor summary{cursor:pointer;color:#657c9f}.playback-editor summary span{float:right;font-size:calc(11px * var(--admin-font-scale, 1))}.playback-device-list{max-height:180px;overflow:auto;padding:8px 0;display:grid;gap:8px}.playback-device-list label{display:flex;gap:7px;align-items:center}.playback-editor small{font-size:calc(10px * var(--admin-font-scale, 1));color:#94a0b2;line-height:1.5}.playback-editor button:disabled{opacity:.5;cursor:default}
</style>
