<script setup>
import { computed } from 'vue'
import { adminSession, canAdminApi } from '../runtime/adminSession.js'
import { useQuickCast } from '../runtime/useQuickCast.js'
const emit = defineEmits(['back'])
const allowed = computed(() => adminSession.displayAuthenticated && canAdminApi('/api/system/cast', 'POST'))
const identity = computed(() => `${adminSession.accountSlotId}:${adminSession.sessionRevision}`)
const { state, busy, error, selectedId, selected, activeId, phase, load, search, start, stop, retry } = useQuickCast({ allowed, identity })
</script>

<template>
  <section class="quick-cast" aria-label="快捷投屏">
    <header class="cast-heading"><button type="button" aria-label="返回账户菜单" @click="emit('back')">‹</button><div><h3>投屏</h3><small>实时大屏 · 局域网电视</small></div><span class="cast-mark" :class="{ live: state.casting }" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span></header>
    <p v-if="!allowed" role="status" class="cast-empty">当前账户未获投屏权限</p>
    <template v-else>
      <section v-if="state.casting" class="cast-live" aria-label="当前投屏">
        <span class="cast-live-dot" aria-hidden="true"></span><div><strong>{{ state.session?.deviceName || '电视' }}</strong><small role="status">{{ phase }}</small></div>
        <button type="button" class="cast-stop" :disabled="Boolean(busy)" @click="stop">{{ busy === 'stop' ? '停止中…' : '停止' }}</button>
        <button v-if="state.session?.state === 'reconnect_failed'" class="cast-retry" :disabled="Boolean(busy)" @click="retry">重新连接</button>
      </section>
      <div class="cast-list-heading"><span>选择电视</span><button type="button" :disabled="Boolean(busy)" @click="search">{{ busy === 'search' ? '搜索中…' : '重新搜索' }}</button></div>
      <div v-if="!state.loaded && !error" class="cast-empty" role="status">正在读取投屏服务…</div>
      <div v-else-if="!state.devices.length && !error" class="cast-empty" role="status"><span class="cast-radar" aria-hidden="true">◉</span><strong>{{ busy === 'search' ? '正在搜索电视' : '未发现电视' }}</strong><small>电视连接同一网络，开启 DLNA 后重试</small></div>
      <ul v-if="state.devices.length" class="cast-devices" aria-label="可用电视">
        <li v-for="device in state.devices" :key="device.id"><button type="button" :class="{ selected: selectedId === device.id, active: activeId === device.id }" :disabled="Boolean(busy) || activeId === device.id" :aria-pressed="selectedId === device.id" @click="selectedId = device.id"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg><span><strong>{{ device.name || device.modelName || '电视' }}</strong><small>{{ device.address || device.modelName }}</small></span><i>{{ activeId === device.id ? '投屏中' : selectedId === device.id ? '✓' : '›' }}</i></button></li>
      </ul>
      <div v-if="selected" class="cast-confirm"><small>将当前大屏投送至</small><strong>{{ selected.name || selected.modelName || '电视' }}</strong><button class="cast-start" type="button" :disabled="Boolean(busy) || !state.encoderReady" @click="start">{{ busy === 'start' ? '正在连接…' : state.casting ? '切换到这台电视' : '开始投屏' }}</button><small v-if="!state.encoderReady">投屏编码器未就绪</small></div>
      <div v-if="error" class="cast-error" role="alert"><span>{{ error }}</span><button type="button" :disabled="Boolean(busy)" @click="load">重试</button></div>
    </template>
  </section>
</template>

<style scoped>
.quick-cast{color:#eeebfa;font-size:12px}.quick-cast button{font:inherit;cursor:pointer;color:inherit}.quick-cast button:disabled{opacity:.5;cursor:default}.quick-cast button:focus-visible{outline:2px solid #b8acf6;outline-offset:2px}.quick-cast svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}.cast-heading{display:flex;gap:10px;align-items:center;padding:0 0 17px;border-bottom:1px solid #cec1f324}.cast-heading>button{padding:0;width:28px;height:32px;background:transparent;border:0;font-size:30px;color:#c4b8e5}.cast-heading>div{flex:1}.cast-heading h3{font-size:16px;margin:0 0 5px;font-weight:600}.cast-heading small,.cast-confirm>small{font-size:10px;color:#b7afce}.cast-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:#b6a0f016;color:#c4b1ff}.cast-mark.live{color:#90dfc7}.cast-live{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:15px 0;border-bottom:1px solid #cec1f324}.cast-live-dot{width:7px;height:7px;border-radius:50%;background:#7eddbb;box-shadow:0 0 12px #79d4b555}.cast-live>div{display:grid;gap:5px;flex:1;min-width:0}.cast-live strong,.cast-confirm strong{overflow-wrap:anywhere;font-size:12px}.cast-live small{color:#9edcc9;font-size:10px}.cast-stop,.cast-retry{padding:7px 12px;border:1px solid #d2c4f42a;border-radius:7px;background:#bba2ee12}.cast-list-heading{display:flex;align-items:center;justify-content:space-between;padding:17px 0 10px;color:#c6bcdc;font-size:11px}.cast-list-heading button,.cast-error button{border:0;background:transparent;color:#b8aff9;font-size:11px;padding:5px}.cast-empty{display:grid;justify-items:center;gap:10px;text-align:center;padding:28px 10px;color:#c6bed6;line-height:1.7}.cast-empty small{font-size:10px;color:#a59ab9}.cast-radar{font-size:27px;color:#a99acb}.cast-devices{list-style:none;padding:0;margin:0;display:grid;gap:6px;max-height:260px;overflow:auto;overscroll-behavior:contain}.cast-devices button{width:100%;display:flex;align-items:center;gap:12px;padding:12px 10px;text-align:left;border:1px solid transparent;border-radius:10px;background:#b6a0f009}.cast-devices button:hover:not(:disabled),.cast-devices button.selected{border-color:#b7a1ed65;background:#b6a0f01e}.cast-devices button>span{display:grid;gap:5px;flex:1;min-width:0}.cast-devices strong{font-size:12px;overflow-wrap:anywhere}.cast-devices small{color:#a99fbd;font-size:10px}.cast-devices i{font-style:normal;font-size:10px;color:#b6dfcf}.cast-confirm{display:grid;gap:9px;margin-top:16px;padding:14px;border:1px solid #c7b5f02e;border-radius:10px;background:#bc9ef00d}.cast-start{padding:11px;border:1px solid #c9b6ff55;border-radius:8px;background:linear-gradient(110deg,#a18bd643,#8574bc33);font-weight:600}.cast-error{display:flex;align-items:center;gap:8px;margin-top:14px;padding:10px;border:1px solid #e7a8b730;border-radius:8px;color:#edbac5;font-size:11px;line-height:1.6;overflow-wrap:anywhere}.cast-error>span{flex:1;min-width:0}
</style>
