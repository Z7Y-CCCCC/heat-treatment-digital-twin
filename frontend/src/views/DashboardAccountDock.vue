<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../../shared/accountPolicy.mjs'
import { adminSession, refreshAdminSession, changeAdminPassword, listAdminAccounts, addAdminAccount, activateAdminAccount, logoutCurrentAdminAccount, canOpenAdmin } from '../runtime/adminSession.js'
import { isNativeUnitySurface } from '../runtime/nativeSurfaceBridge.js'
import { openAdminSurface, openCustomerOperations } from '../runtime/nativeAdminNavigation.js'
import QualityCapsule from '../components/QualityCapsule.vue'
import QualityNotice from '../components/QualityNotice.vue'
import { useNativeQuality } from '../runtime/nativeQuality.js'
const route=useRoute(),router=useRouter()
const {qualityState,setQuality,queryQuality}=useNativeQuality()
const adminSurface=computed(()=>isNativeUnitySurface(route.query.embedded,window.chrome?.webview) && route.query.surface==='admin')
function openAdmin(){openAdminSurface({embedded:route.query.embedded,surface:adminSurface.value?'admin':undefined,webview:window.chrome?.webview,router})}
const accessStatus=computed(()=>!adminSession.ready?'读取账户状态…':!adminSession.configured?'首次设置密码':adminSession.displayAuthenticated?adminSession.authenticated?({owner:'系统管理员',customer:'现场客户',editor:'现场客户',viewer:'现场查看'}[adminSession.user?.role] || '已登录'):'后台已锁定 · 大屏展示中':'未登录 · 需要登录')
const accountOpen=ref(false),accountBusy=ref(false),accountError=ref(''),accountNotice=ref(''),accountSessions=ref([]),accountAddOpen=ref(false),accountAddUsername=ref(''),accountAddPassword=ref(''),accountCurrentPassword=ref(''),accountNewPassword=ref(''),accountPasswordMode=ref(false)
const visibleAccountSessions=computed(()=>[...accountSessions.value].sort((a,b)=>Number(b.slotId===adminSession.accountSlotId)-Number(a.slotId===adminSession.accountSlotId)))
async function loadAccountSessions(){try{accountSessions.value=await listAdminAccounts()}catch(error){accountError.value=error.message}}
async function toggleAccount(){accountOpen.value=!accountOpen.value;accountError.value='';accountNotice.value='';if(accountOpen.value){await refreshAdminSession();await loadAccountSessions()}}
function requestAdminLogin(){accountOpen.value=false;const webview=window.chrome?.webview;if(isNativeUnitySurface(route.query.embedded,webview)){webview.postMessage({type:'host_action',action:'show_admin',returnToDashboard:true});return}router.push({path:'/admin',query:{redirect:route.fullPath}})}
function makeAccountSlotId(){const bytes=new Uint8Array(12);window.crypto.getRandomValues(bytes);return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')}
async function addAccount(){accountBusy.value=true;accountError.value='';accountNotice.value='';try{await addAdminAccount(makeAccountSlotId(),accountAddUsername.value,accountAddPassword.value);accountAddUsername.value='';accountAddPassword.value='';accountAddOpen.value=false;await loadAccountSessions()}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}
async function switchAccount(account){if(account.slotId===adminSession.accountSlotId)return;accountBusy.value=true;accountError.value='';accountNotice.value='';try{if(account.needsLogin){accountAddUsername.value=account.user.username;accountAddPassword.value='';accountAddOpen.value=true;accountNotice.value='登录已失效，请输入密码重新登录';return}await activateAdminAccount(account.slotId,account.csrfToken);await loadAccountSessions()}catch(error){accountError.value=error.message;await loadAccountSessions()}finally{accountBusy.value=false}}
async function signOut(){accountBusy.value=true;accountError.value='';accountNotice.value='';try{await logoutCurrentAdminAccount();accountPasswordMode.value=false;accountAddOpen.value=false;await loadAccountSessions();accountNotice.value=accountSessions.value.length?'当前账户已退出，可从下方切换到其他已登录账户':'当前账户已退出'}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}
async function changeOwnPassword(){accountBusy.value=true;accountError.value='';try{await changeAdminPassword(accountCurrentPassword.value,accountNewPassword.value);accountCurrentPassword.value='';accountNewPassword.value='';accountPasswordMode.value=false;await loadAccountSessions();accountNotice.value='密码已更新，其他会话已退出'}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}

const dock=ref(null), hidden=ref(false)
let timer=0, hovering=false, motionFrame=0
function geometry(){window.dispatchEvent(new Event('account-dock-geometry'))}
function trackMotion(){
  cancelAnimationFrame(motionFrame)
  const until=performance.now()+300
  function frame(){geometry();if(performance.now()<until)motionFrame=requestAnimationFrame(frame)}
  motionFrame=requestAnimationFrame(frame)
}
function arm(){
  clearTimeout(timer)
  timer=setTimeout(()=>{
    if(accountOpen.value || accountBusy.value || hovering || dock.value?.querySelector(':focus-visible,input:focus'))return
    hidden.value=true
  },2500)
}
function reveal(){hidden.value=false;arm()}
function enter(){hovering=true;reveal()}
function leave(){hovering=false;arm()}
function escape(event){if(event.key==='Escape' && accountOpen.value){accountOpen.value=false;event.preventDefault();event.stopPropagation();arm()}}
watch(()=>qualityState.notice,()=>nextTick(trackMotion))
watch([hidden,accountOpen],()=>{nextTick(trackMotion);if(!accountOpen.value)arm()})
watch(()=>route.path,()=>{accountOpen.value=false;accountAddPassword.value='';accountCurrentPassword.value='';accountNewPassword.value='';hidden.value=false;arm();nextTick(refreshAdminSession)})
onMounted(()=>{void refreshAdminSession();arm();window.addEventListener('keydown',escape,true);geometry()})
onUnmounted(()=>{clearTimeout(timer);cancelAnimationFrame(motionFrame);window.removeEventListener('keydown',escape,true);geometry()})
</script>

<template>
<QualityNotice :state="qualityState" />
<div ref="dock" class="account-dock" :class="{'is-hidden':hidden}" data-overlay-hit="true" data-account-hit="true" aria-label="右上角账户入口" @pointerenter="enter" @pointermove="reveal" @pointerleave="leave" @focusin="reveal" @focusout="arm">
    <button class="group-user" type="button" :aria-label="`${accessStatus}，打开账户菜单`" :aria-expanded="accountOpen" @click="toggleAccount"><span class="group-user-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ adminSession.user?.displayName || (adminSession.configured ? '账户':'后台账户') }}</strong><small>{{ adminSession.displayAuthenticated ? accessStatus : '点击登录' }}</small></span><i class="group-user-state" :class="{verified:adminSession.displayAuthenticated}" aria-hidden="true"></i></button>
    <div v-if="accountOpen" class="group-account-menu" data-overlay-hit="true" data-account-hit="true" role="region" aria-label="账户设置">
      <template v-if="!adminSession.displayAuthenticated">
        <header class="group-account-profile"><span class="group-account-avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ accountSessions.length ? '选择账户' : '尚未登录' }}</strong><small>{{ accountSessions.length ? '本机已保存有效登录会话' : '请登录后查看生产大屏与现场数据' }}</small></span></header>
        <section v-if="accountSessions.length" class="group-account-list" aria-label="已登录账户"><small>本机账户 · {{ accountSessions.length }}</small><button v-for="account in visibleAccountSessions" :key="account.slotId" type="button" :disabled="accountBusy" @click="switchAccount(account)"><span class="group-account-avatar small">{{ (account.user?.displayName || account.user?.username || '?').slice(0,1) }}</span><span><strong>{{ account.user?.displayName || account.user?.username }}</strong><small>{{ account.user?.username }} · {{ ({owner:'系统管理员',customer:'现场客户',viewer:'现场查看'}[account.user?.role] || (account.needsLogin ? '需重新登录' : '已登录')) }}</small></span><i>切换 →</i></button></section>
        <p class="group-account-message">{{ adminSession.configured ? '请使用后台管理页登录；登录成功后将自动返回实时大屏。' : '首次使用请在后台管理页完成管理员初始化。' }}</p>
        <button class="group-account-action group-account-primary" type="button" @click="requestAdminLogin">前往后台管理登录 <span>→</span></button>
      </template>
      <template v-else>
        <header class="group-account-profile"><span class="group-account-avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ adminSession.user?.displayName }}</strong><small>{{ adminSession.user?.username }} · {{ accessStatus }}</small></span></header>
        <QualityCapsule :state="qualityState" @select="setQuality" @query="queryQuality" />
        <section v-if="accountSessions.length>1 || accountSessions.some(account=>account.needsLogin)" class="group-account-list" aria-label="已登录账户"><small>本机账户 · {{ accountSessions.length }}</small><button v-for="account in visibleAccountSessions" :key="account.slotId" type="button" :class="{active:account.slotId===adminSession.accountSlotId}" :disabled="accountBusy || account.slotId===adminSession.accountSlotId" @click="switchAccount(account)"><span class="group-account-avatar small">{{ (account.user?.displayName || account.user?.username || '?').slice(0,1) }}</span><span><strong>{{ account.user?.displayName || account.user?.username }}</strong><small>{{ account.user?.username }} · {{ ({owner:'系统管理员',customer:'现场客户',viewer:'现场查看'}[account.user?.role] || (account.needsLogin ? '需重新登录' : '已登录')) }}</small></span><i>{{ account.needsLogin ? '重新登录 →' : account.slotId===adminSession.accountSlotId ? '当前账户':'切换 →' }}</i></button></section>
        <button v-if="!adminSession.authenticated" class="group-account-action group-account-primary" type="button" @click="requestAdminLogin">解锁设置页面 <span>→</span></button>
        <button v-else-if="canOpenAdmin()" class="group-account-action group-account-primary" type="button" @click="openAdmin">设置页面 <span>→</span></button>
        <button v-else-if="adminSession.permissions.cast || adminSession.permissions.backup" class="group-account-action group-account-primary" type="button" @click="openCustomerOperations({embedded:route.query.embedded,surface:route.query.surface,webview:window.chrome?.webview,router})">现场操作中心 <span>→</span></button>
        <button class="group-account-action" type="button" :disabled="accountBusy || accountSessions.filter(account=>!account.needsLogin).length>=8" @click="accountAddOpen=!accountAddOpen">{{ accountAddOpen ? '收起账户管理':'管理账户' }}<span>{{ accountAddOpen ? '−':'＋' }}</span></button>
        <form v-if="accountAddOpen" class="group-account-form" @submit.prevent="addAccount"><label>账号<input v-model.trim="accountAddUsername" autocomplete="username" required maxlength="32" /></label><label>密码<input v-model="accountAddPassword" type="password" autocomplete="current-password" required :minlength="MIN_PASSWORD_LENGTH" :maxlength="MAX_PASSWORD_LENGTH" /></label><button class="group-account-primary" type="submit" :disabled="accountBusy">{{ accountBusy ? '验证中…':'添加并切换' }}<span>→</span></button></form>
        <button v-if="adminSession.authenticated" class="group-account-action" type="button" @click="accountPasswordMode=!accountPasswordMode">{{ accountPasswordMode ? '收起修改密码':'修改我的密码' }}<span>{{ accountPasswordMode ? '−':'＋' }}</span></button>
        <form v-if="accountPasswordMode" class="group-account-form" @submit.prevent="changeOwnPassword"><label>当前密码<input v-model="accountCurrentPassword" type="password" autocomplete="current-password" :minlength="MIN_PASSWORD_LENGTH" :maxlength="MAX_PASSWORD_LENGTH" required /></label><label>新密码<input v-model="accountNewPassword" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD_LENGTH" :maxlength="MAX_PASSWORD_LENGTH" required /></label><button class="group-account-primary" type="submit" :disabled="accountBusy">保存新密码<span>→</span></button></form>
        <button class="group-account-action group-account-exit" :disabled="accountBusy" type="button" @click="signOut">退出当前账户 <span>↗</span></button>
      </template>
      <p v-if="accountError" class="group-account-message error" role="alert">{{ accountError }}</p>
      <p v-if="accountNotice" class="group-account-message" role="status">{{ accountNotice }}</p>
    </div>

</div>
</template>
<style scoped>
.group-user{position:absolute;z-index:3;right:3%;top:4%;display:flex;align-items:center;gap:9px;padding:7px 11px 7px 7px;border:1px solid rgba(149,164,203,.2);border-radius:999px;background:linear-gradient(115deg,rgba(29,35,53,.74),rgba(19,23,37,.44));color:#d9deec;text-align:left;cursor:pointer;transition:border-color .2s ease,background .2s ease}.group-user:hover{border-color:rgba(166,179,224,.48);background:rgba(34,41,62,.8)}.group-user-icon{display:grid;place-items:center;width:29px;height:29px;border:1px solid rgba(154,169,218,.28);border-radius:50%;color:#c2c9e1;background:rgba(134,148,201,.1)}.group-user-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}.group-user>span:nth-child(2){display:grid;gap:3px}.group-user strong{font-size:10px;font-weight:500;letter-spacing:.04em}.group-user small{font-size:9px;color:#8792aa;white-space:nowrap}.group-user-state{width:6px;height:6px;border-radius:50%;background:#c5a878;box-shadow:0 0 8px rgba(197,168,120,.42)}.group-user-state.verified{background:#63d2a7;box-shadow:0 0 9px rgba(99,210,167,.5)}.group-user:focus-visible{outline:2px solid #a7b2f1;outline-offset:3px}
.group-user{border-color:rgba(214,212,203,.12);background:linear-gradient(115deg,rgba(218,216,208,.13),rgba(218,216,208,.055));color:#e1dfda;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.group-user:hover{border-color:rgba(222,220,211,.25);background:rgba(218,216,208,.16)}
.group-user-icon{border-color:rgba(214,212,203,.2);background:rgba(205,203,195,.075);color:#dad8d1}
.group-account-menu{position:absolute;z-index:12;right:3%;top:calc(4% + 51px);width:min(318px,calc(100vw - 32px));max-height:min(76vh,620px);overflow:auto;box-sizing:border-box;padding:17px;border:1px solid rgba(224,222,214,.18);border-radius:16px;background:linear-gradient(148deg,rgba(57,57,60,.97),rgba(38,39,41,.98) 76%);box-shadow:0 20px 55px rgba(0,0,0,.23),inset 0 1px 0 rgba(255,255,255,.075);backdrop-filter:blur(24px) saturate(.82);-webkit-backdrop-filter:blur(24px) saturate(.82);color:#e8e7e1}
.group-account-profile{display:flex;align-items:center;gap:12px;padding:2px 2px 15px;border-bottom:1px solid rgba(229,226,218,.11)}.group-account-profile>span:last-child{display:grid;gap:5px;min-width:0}.group-account-profile strong{overflow:hidden;color:#f0efeb;font-size:14px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.group-account-profile small{overflow:hidden;color:#aaa9a5;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.group-account-avatar{display:grid;place-items:center;flex:0 0 auto;width:44px;height:44px;border:1px solid rgba(224,222,214,.13);border-radius:50%;background:rgba(222,220,213,.085);color:#d5d4cf;font-size:15px}.group-account-avatar svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round}.group-account-avatar.small{width:31px;height:31px;font-size:12px}
.group-account-list{display:grid;gap:5px;padding:12px 0 6px}.group-account-list>small{padding:0 4px 3px;color:#aaa9a4;font-size:9px;letter-spacing:.06em}.group-account-list>button{display:flex;align-items:center;gap:9px;width:100%;margin:0;padding:8px 7px;border:1px solid transparent;border-radius:9px;background:transparent;color:#e8e7e1;text-align:left;cursor:pointer}.group-account-list>button:hover:not(:disabled){border-color:rgba(224,222,214,.13);background:rgba(229,226,218,.075)}.group-account-list>button.active{border-color:rgba(224,222,214,.11);background:rgba(229,226,218,.055)}.group-account-list>button>span:nth-child(2){display:grid;gap:3px;flex:1;min-width:0}.group-account-list>button strong{overflow:hidden;font-size:10px;font-weight:530;text-overflow:ellipsis;white-space:nowrap}.group-account-list>button small{overflow:hidden;color:#aaa9a4;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.group-account-list>button i{color:#b9c9bf;font-size:9px;font-style:normal;white-space:nowrap}
.group-account-action{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:7px 0 0;padding:10px 11px;border:1px solid rgba(224,222,214,.13);border-radius:9px;background:rgba(225,223,215,.065);color:#e8e7e1;font:500 11px/1.25 var(--hud-font-text,'Inter','Noto Sans SC',sans-serif);text-align:left;cursor:pointer;transition:background .16s ease,border-color .16s ease}.group-account-action:hover:not(:disabled){border-color:rgba(224,222,214,.26);background:rgba(225,223,215,.105)}.group-account-action>span{color:#b8c8bd;font-size:14px}.group-account-menu .group-account-primary{border-color:rgba(205,213,204,.27);background:linear-gradient(110deg,rgba(205,213,204,.17),rgba(205,213,204,.09));color:#f0efea}.group-account-menu .group-account-primary:hover:not(:disabled){border-color:rgba(215,223,214,.43);background:rgba(205,213,204,.19)}.group-account-form{display:grid;gap:9px;margin:12px 0 4px;padding:12px;border:1px solid rgba(224,222,214,.11);border-radius:10px;background:rgba(16,16,18,.12)}.group-account-form label{display:grid;gap:5px;color:#bcbab4;font-size:9px}.group-account-form input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid rgba(224,222,214,.19);border-radius:7px;background:rgba(17,17,19,.28);color:#f0efeb;font:inherit;font-size:11px}.group-account-form input:focus{border-color:rgba(205,213,204,.48);outline:0;box-shadow:0 0 0 2px rgba(205,213,204,.08)}.group-account-form .group-account-primary{margin-top:2px;text-align:left}.group-account-form .group-account-primary>span{margin-left:auto}
.group-account-menu .group-account-exit{margin-top:12px;color:#ddc5bd}.group-account-menu button:disabled{opacity:.56;cursor:wait}.group-account-message{margin:11px 2px 0;color:#b8d4c1;font-size:10px;line-height:1.5}.group-account-message.error{color:#ecaaa1}
.account-dock{position:fixed;right:0;top:0;width:180px;height:54px;z-index:2000;font-family:var(--hud-font-text,Inter,'Noto Sans SC',sans-serif)}
.account-dock .group-user{position:absolute;right:0;top:0;max-width:180px;min-height:44px;border-top-right-radius:0;border-bottom-right-radius:0;transition:transform .24s ease,opacity .24s ease;transform:translateX(0)}
.account-dock.is-hidden .group-user{transform:translateX(calc(100% + 2px));opacity:0;pointer-events:none}
.account-dock .group-account-menu{position:fixed;right:0;top:50px;max-height:calc(100dvh - 54px);width:min(318px,100vw);border-top-right-radius:0;border-bottom-right-radius:0}
@media(prefers-reduced-motion:reduce){.account-dock .group-user{transition:none}}

</style>
