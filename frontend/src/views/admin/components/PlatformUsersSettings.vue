<script setup>
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH, USERNAME_PATTERN } from '../../../../../shared/accountPolicy.mjs'
import { PAGE_ACTIONS, normalizePagePermissions } from '../../../../../shared/pagePermissions.mjs'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { adminPageCatalog, getAdminPageCatalog, createPlatformUser, deletePlatformUser, listPlatformUsers, updatePlatformUser } from '../../../runtime/adminSession.js'

const pages = computed(() => adminPageCatalog.value)

const permissionChoices = [
  { key: 'view', label: '查看大屏', detail: '实时大屏与区域分布' },
  { key: 'launch', label: '启动大屏', detail: '打开或切换大屏' },
  { key: 'cast', label: '投屏管理', detail: '选择终端并控制投屏' },
  { key: 'backup', label: '备份操作', detail: '创建与下载备份' }
]
const defaultPermissions = role => ({ view: true, launch: role === 'customer', cast: role === 'customer', backup: role === 'customer' })
function editablePermissions(role, permissions = {}) {
  const defaults = defaultPermissions(role)
  return Object.fromEntries(permissionChoices.map(({ key }) => [key,
    typeof permissions[key] === 'boolean' ? permissions[key] : defaults[key]
  ]))
}
const createDraft = () => ({ username: '', displayName: '', role: 'customer', password: '', enabled: true, permissions: defaultPermissions('customer'), pagePermissions: normalizePagePermissions() })
const pageActions = Object.keys(PAGE_ACTIONS)
function changePageView(page) {
  if (!editor.value.pagePermissions[page.key].view) {
    for (const action of page.actions) editor.value.pagePermissions[page.key][action] = false
  }
}
function changePageAction(page, action) {
  if (action === 'view') changePageView(page)
  if (page.key === 'models' && !editor.value.pagePermissions.models.edit) editor.value.pagePermissions.models.publish = false
}
function setPagePreset(mode) {
  editor.value.pagePermissions = Object.fromEntries(pages.value.map(page => [page.key,
    Object.fromEntries(page.actions.map(action => [action, !page.ownerOnly && (mode === 'all' || mode === 'view' && action === 'view')]))
  ]))
}
const users = ref([])
const busy = ref(false)
const loading = ref(true)
const notice = ref(null)
let noticeTimer = null
function clearNotice() {
  globalThis.window?.clearTimeout(noticeTimer)
  noticeTimer = null
  notice.value = null
}
function showNotice(message, type = 'error') {
  if (disposed) return
  clearNotice()
  notice.value = { message: String(message), type }
  // Errors remain readable until dismissed or retried; success is transient.
  if (type === 'success') noticeTimer = globalThis.window?.setTimeout(clearNotice, 4000)
}
const editorOpen = ref(false)
const editorMode = ref('create')
const editor = ref(createDraft())
const editingId = ref('')
const replacementPassword = ref('')
const pendingDelete = ref(false)
const catalogError = ref('')
let catalogRequest = null
let catalogTimer = null
let disposed = false

// Refresh metadata only: never reload an account over unsaved checkbox changes.
function reconcilePageDraft() {
  const old = editor.value.pagePermissions
  editor.value.pagePermissions = Object.fromEntries(pages.value.map(page => [page.key,
    Object.fromEntries(page.actions.map(action => [action, !page.ownerOnly && old[page.key]?.view === true && old[page.key]?.[action] === true]))
  ]))
}
watch(adminPageCatalog, reconcilePageDraft, { flush: 'sync' })
async function refreshPageCatalog() {
  if (disposed) return
  if (catalogRequest) return catalogRequest
  catalogRequest = (async () => {
    try { await getAdminPageCatalog(); if (!disposed) catalogError.value = '' }
    catch { if (!disposed) catalogError.value = '页面目录暂未更新，正在重试' }
    finally { catalogRequest = null }
  })()
  return catalogRequest
}
function refreshVisibleCatalog() {
  if (editorOpen.value && !globalThis.document?.hidden) void refreshPageCatalog()
}

const editorTitle = computed(() => editorMode.value === 'create' ? '新增账户' : `编辑账户 · ${editor.value.username}`)

async function loadUsers() {
  loading.value = true
  try {
    await refreshPageCatalog()
    users.value = (await listPlatformUsers()).map(user => ({
      ...user,
      pagePermissions: normalizePagePermissions(user.pagePermissions),
      permissions: editablePermissions(user.role, user.permissions || {})
    }))
  } catch (error) {
    showNotice(error.message || '读取账户列表失败')
  } finally { loading.value = false }
}

function openCreate() {
  clearNotice()
  editorMode.value = 'create'
  editor.value = createDraft()
  editingId.value = ''
  replacementPassword.value = ''
  pendingDelete.value = false
  editorOpen.value = true
  void refreshPageCatalog()
}

function openEdit(user) {
  clearNotice()
  editorMode.value = 'edit'
  editingId.value = user.id
  editor.value = {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: Boolean(user.enabled),
    pagePermissions: normalizePagePermissions(user.pagePermissions),
    permissions: editablePermissions(user.role, user.permissions || {})
  }
  replacementPassword.value = ''
  pendingDelete.value = false
  editorOpen.value = true
  void refreshPageCatalog()
}

function closeEditor() {
  if (busy.value) return
  clearNotice()
  editorOpen.value = false
  pendingDelete.value = false
}

function applyRolePreset() {
  editor.value.permissions = defaultPermissions(editor.value.role)
}

async function saveEditor() {
  if (busy.value) return
  busy.value = true
  clearNotice()
  try {
    if (editorMode.value === 'create') {
      await createPlatformUser({ ...editor.value, permissions: editablePermissions(editor.value.role, editor.value.permissions) })
      showNotice('账户已创建', 'success')
    } else {
      await updatePlatformUser(editingId.value, {
        displayName: editor.value.displayName,
        role: editor.value.role,
        enabled: editor.value.enabled,
        permissions: editablePermissions(editor.value.role, editor.value.permissions),
        pagePermissions: normalizePagePermissions(editor.value.pagePermissions),
        ...(replacementPassword.value ? { password: replacementPassword.value } : {})
      })
      showNotice('账户已更新，该账户需重新登录', 'success')
    }
    editorOpen.value = false
    await loadUsers()
  } catch (error) {
    showNotice(error.message || '保存账户失败')
  } finally { busy.value = false }
}

async function removeEditorUser() {
  if (busy.value) return
  if (!pendingDelete.value) {
    pendingDelete.value = true
    return
  }
  busy.value = true
  clearNotice()
  try {
    await deletePlatformUser(editingId.value)
    editorOpen.value = false
    showNotice('账户已删除', 'success')
    await loadUsers()
  } catch (error) {
    showNotice(error.message || '删除账户失败')
  } finally {
    busy.value = false
    pendingDelete.value = false
  }
}

function roleLabel(role) {
  return role === 'owner' ? '系统管理员' : role === 'viewer' ? '现场查看' : '现场客户'
}

function permissionSummary(user) {
  return [...permissionChoices.filter(choice => user.permissions?.[choice.key]).map(choice => choice.label),
    ...pages.value.filter(page => !page.retired && user.pagePermissions?.[page.key]?.view).map(page => page.label)]
}

onMounted(() => {
  void loadUsers()
  catalogTimer = globalThis.window?.setInterval(refreshVisibleCatalog, 5000)
  globalThis.window?.addEventListener('focus', refreshVisibleCatalog)
  globalThis.document?.addEventListener('visibilitychange', refreshVisibleCatalog)
})
onUnmounted(() => {
  disposed = true
  clearNotice()
  globalThis.window?.clearInterval(catalogTimer)
  globalThis.window?.removeEventListener('focus', refreshVisibleCatalog)
  globalThis.document?.removeEventListener('visibilitychange', refreshVisibleCatalog)
})
</script>

<template>
  <section class="users-settings" aria-labelledby="platform-users-title">
    <header class="users-heading">
      <div><h3 id="platform-users-title">用户与权限</h3><p>按账户分配页面与操作权限。</p></div>
      <button type="button" class="users-primary" @click="openCreate">＋ 新增账户</button>
    </header>

    <div class="users-toolbar"><span>{{ users.length }} 个现场账户</span><button type="button" :disabled="loading" @click="loadUsers">刷新列表</button></div>
    <div v-if="loading" class="users-state">正在读取账户…</div>
    <div v-else-if="users.length" class="users-table-wrap">
      <table class="users-table">
        <thead><tr><th>账户</th><th>角色</th><th>功能权限</th><th>状态</th><th><span class="sr-only">操作</span></th></tr></thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td><strong>{{ user.displayName || user.username }}</strong><small>{{ user.username }}</small></td>
            <td><span class="role-badge">{{ roleLabel(user.role) }}</span></td>
            <td><div class="permission-tags"><span v-for="label in permissionSummary(user)" :key="label">{{ label }}</span><em v-if="!permissionSummary(user).length">无功能权限</em></div></td>
            <td><span class="account-state" :class="{ disabled: !user.enabled }"><i></i>{{ user.enabled ? '已启用' : '已停用' }}</span></td>
            <td><button type="button" class="users-edit" @click="openEdit(user)">管理账户</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="users-state">暂无现场账户。系统管理员账户保留，不会列入可删除账户。</div>

    <Teleport to="body">
      <Transition name="user-editor">
        <!-- Selecting text may release the pointer over the mask; never dismiss on a backdrop click. -->
        <div v-if="editorOpen" class="user-editor-backdrop" @keydown.esc.stop.prevent="closeEditor">
          <section class="user-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="user-editor-title">
            <header><div><h4 id="user-editor-title">{{ editorTitle }}</h4><p>{{ editorMode === 'create' ? '账户创建后即可按已授权页面和功能工作。' : '切换角色模板仅重置现场功能；后台页面权限独立设置。' }}</p></div><button type="button" class="editor-close" aria-label="关闭" :disabled="busy" @click="closeEditor">×</button></header>
            <form class="editor-form" @submit.prevent="saveEditor">
              <label v-if="editorMode === 'create'">登录账号<input v-model.trim="editor.username" autocomplete="off" :minlength="MIN_USERNAME_LENGTH" :maxlength="MAX_USERNAME_LENGTH" :pattern="USERNAME_PATTERN" required placeholder="例如 普通用户1" /></label>
              <label v-else>登录账号<input :value="editor.username" disabled /></label>
              <label>显示名称<input v-model.trim="editor.displayName" maxlength="60" required placeholder="例如 车间值班员" /></label>
              <label>角色模板<select v-model="editor.role" @change="applyRolePreset"><option value="customer">现场客户</option><option value="viewer">现场查看</option></select></label>
              <label v-if="editorMode === 'create'">初始密码<input v-model="editor.password" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD_LENGTH" :maxlength="MAX_PASSWORD_LENGTH" required :placeholder="`至少 ${MIN_PASSWORD_LENGTH} 位`" /></label>
              <label v-else>重设密码<input v-model="replacementPassword" type="password" autocomplete="new-password" :minlength="MIN_PASSWORD_LENGTH" :maxlength="MAX_PASSWORD_LENGTH" placeholder="留空则不修改" /></label>
              <label v-if="editorMode === 'edit'" class="editor-enabled"><input v-model="editor.enabled" type="checkbox" />启用此账户</label>
              <fieldset class="capability-fieldset"><legend>功能权限</legend><label v-for="choice in permissionChoices" :key="choice.key" class="capability-option"><input v-model="editor.permissions[choice.key]" type="checkbox" /><span><strong>{{ choice.label }}</strong><small>{{ choice.detail }}</small></span></label></fieldset>
              <fieldset class="page-permission-fieldset">
                <legend>后台页面权限</legend>
                <div class="page-permission-presets">
                  <button type="button" @click="setPagePreset('view')">业务页面全部只读</button>
                  <button type="button" @click="setPagePreset('all')">业务页面全部操作</button>
                  <button type="button" @click="setPagePreset('none')">清空后台授权</button>
                </div>
                <div class="page-permission-scroll"><table class="page-permission-table">
                  <thead><tr><th>页面</th><th v-for="action in pageActions" :key="action">{{ PAGE_ACTIONS[action] }}</th></tr></thead>
                  <tbody><tr v-for="page in pages.filter(item => !item.retired)" :key="page.key">
                    <th scope="row">{{ page.label }}</th>
                    <td v-for="action in pageActions" :key="action">
                      <input v-if="page.actions.includes(action)" v-model="editor.pagePermissions[page.key][action]" type="checkbox"
                        :aria-label="`${page.label} · ${PAGE_ACTIONS[action]}`"
                        :disabled="busy || page.ownerOnly || action !== 'view' && !editor.pagePermissions[page.key].view || page.key === 'models' && action === 'publish' && !editor.pagePermissions.models.edit"
                        @change="changePageAction(page, action)" />
                      <span v-else aria-hidden="true">—</span>
                    </td>
                  </tr></tbody>
                </table></div>
                <p v-if="catalogError" class="editor-error" role="status">{{ catalogError }}</p>
              </fieldset>
              <p class="editor-hint">先勾选查看，再分配操作权限。修改后该账户需重新登录。</p>
              <footer>
                <button v-if="editorMode === 'edit'" type="button" class="editor-delete" :disabled="busy" @click="removeEditorUser">{{ pendingDelete ? '确认删除此账户' : '删除账户' }}</button>
                <span class="editor-spacer"></span>
                <button type="button" class="editor-cancel" :disabled="busy" @click="closeEditor">取消</button>
                <button type="submit" class="users-primary" :disabled="busy">{{ busy ? '保存中…' : editorMode === 'create' ? '创建账户' : '保存修改' }}</button>
              </footer>
            </form>
          </section>
        </div>
      </Transition>
    </Teleport>
    <Teleport to="body">
      <Transition name="user-notice">
        <div v-if="notice" class="user-notice" :class="notice.type" :role="notice.type === 'error' ? 'alert' : 'status'" aria-atomic="true">
          <svg class="user-notice-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <circle cx="10" cy="10" r="8" />
            <path v-if="notice.type === 'error'" d="M10 5.5v5M10 13.5v1" />
            <path v-else d="m6 10 2.5 2.5L14 7" />
          </svg>
          <span>{{ notice.message }}</span>
          <button type="button" class="user-notice-close" aria-label="关闭消息" @click="clearNotice">×</button>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.page-permission-fieldset{grid-column:1/-1;margin:0;border:1px solid #e3e8ef;border-radius:8px;padding:12px;min-width:0}.page-permission-fieldset legend{font-size:12px;color:#43526a}.page-permission-presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.page-permission-presets button{background:#f4f7fc;border:1px solid #d5ddea;border-radius:6px;padding:6px 8px;color:#405879;font-size:11px;cursor:pointer}.page-permission-scroll{overflow:auto}.page-permission-table{width:100%;border-collapse:collapse;font-size:11px;min-width:490px}.page-permission-table th,.page-permission-table td{padding:8px 5px;border-bottom:1px solid #edf0f4;text-align:center}.page-permission-table th:first-child{text-align:left;font-weight:500}.page-permission-table thead{color:#63728a;background:#f7f9fc}.page-permission-table input{width:16px;height:16px}.page-permission-table input:disabled{opacity:.4}
.users-settings{padding:24px 26px;background:#fff;border:1px solid #e1e6ee;border-radius:12px;color:#263349}.users-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.users-heading h3{margin:0 0 7px;font-size:19px}.users-heading p{margin:0;color:#758198;font-size:12px;line-height:1.7}.users-primary,.editor-cancel,.users-edit,.users-toolbar button,.editor-delete{border:1px solid #d5ddea;border-radius:7px;padding:8px 12px;background:#fff;color:#405879;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.users-primary{border-color:#316cda;background:#316cda;color:white}.users-primary:hover{background:#245cc4}.users-primary:disabled,.editor-cancel:disabled,.editor-delete:disabled{opacity:.55;cursor:wait}.users-toolbar{display:flex;justify-content:space-between;align-items:center;margin:21px 0 9px;color:#758198;font-size:11px}.users-toolbar button{padding:6px 9px}.users-table-wrap{overflow:auto;border:1px solid #e5e9f0;border-radius:8px}.users-table{width:100%;border-collapse:collapse;text-align:left}.users-table th{padding:10px 13px;background:#f7f9fc;color:#758198;font-size:10px;font-weight:600;white-space:nowrap}.users-table td{padding:11px 13px;border-top:1px solid #edf0f4;font-size:12px;vertical-align:middle}.users-table td:first-child strong,.users-table td:first-child small{display:block}.users-table td:first-child strong{font-weight:600}.users-table td:first-child small{margin-top:3px;color:#8c97a9;font-size:10px}.role-badge{padding:4px 7px;border-radius:5px;background:#f2f5fa;color:#5f6e84;font-size:10px}.permission-tags{display:flex;gap:4px;flex-wrap:wrap}.permission-tags span{padding:3px 6px;border:1px solid #e6ebf2;border-radius:4px;color:#63728a;font-size:9px;white-space:nowrap}.permission-tags em{color:#9aa3b1;font-size:10px;font-style:normal}.account-state{display:inline-flex;align-items:center;gap:5px;color:#27845c;font-size:10px;white-space:nowrap}.account-state i{width:6px;height:6px;border-radius:50%;background:#4fb78b}.account-state.disabled{color:#9b6670}.account-state.disabled i{background:#d08a92}.users-edit{padding:6px 9px}.users-state{padding:30px 12px;text-align:center;color:#8792a4;font-size:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.user-editor-backdrop{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:rgba(20,29,43,.38);backdrop-filter:blur(3px)}.user-editor-dialog{display:flex;flex-direction:column;width:min(640px,100%);max-height:min(780px,calc(100vh - 40px));overflow:hidden;border:1px solid #dbe1ea;border-radius:14px;background:#fff;box-shadow:0 26px 80px rgba(20,29,43,.24)}.user-editor-dialog>header{position:relative;flex-shrink:0;display:flex;justify-content:space-between;gap:16px;padding:21px 48px 17px 24px;border-bottom:1px solid #edf0f4}.user-editor-dialog h4{margin:0 0 5px;font-size:16px}.user-editor-dialog header p{margin:0;color:#7a8699;font-size:11px;line-height:1.6}.editor-close{position:absolute;top:8px;right:8px;display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:4px;background:transparent;box-shadow:none;color:#68778c;font-size:20px;line-height:1;cursor:pointer}.editor-close:hover{color:#263349}.editor-close:focus-visible{outline:2px solid #386dca;outline-offset:1px}.editor-close:disabled{opacity:.45;cursor:wait}.editor-form{min-height:0;overflow-y:auto;overscroll-behavior:contain;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:19px 24px 22px}.editor-form>label{display:grid;gap:6px;color:#58677d;font-size:11px}.editor-form input:not([type=checkbox]),.editor-form select{box-sizing:border-box;width:100%;min-width:0;padding:9px 10px;border:1px solid #d5dce6;border-radius:6px;background:#fff;color:#263349;font:inherit;font-size:12px}.editor-form input:disabled{background:#f5f6f8;color:#8b95a6}.editor-form input[type=checkbox]{accent-color:#386dca}.editor-enabled{display:flex!important;align-items:center;gap:7px!important}.capability-fieldset{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:12px;border:1px solid #e3e8ef;border-radius:8px}.capability-fieldset legend{padding:0 5px;color:#69778c;font-size:10px}.capability-option{display:flex!important;align-items:flex-start;gap:8px!important;padding:9px;border:1px solid #e9edf3;border-radius:6px;background:#fff}.capability-option input{margin:2px 0 0}.capability-option span{display:grid;gap:3px}.capability-option strong{color:#43526a;font-size:11px;font-weight:600}.capability-option small{color:#98a2b1;font-size:10px}.editor-hint,.editor-error{grid-column:1/-1;margin:0;color:#8290a3;font-size:10px;line-height:1.6}.editor-error{font-size:12px}.editor-form footer{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding-top:7px}.editor-spacer{flex:1}.editor-delete{border-color:#f0d0d2;color:#a34149}.user-editor-enter-active,.user-editor-leave-active{transition:opacity .16s ease}.user-editor-enter-active .user-editor-dialog,.user-editor-leave-active .user-editor-dialog{transition:transform .16s ease}.user-editor-enter-from,.user-editor-leave-to{opacity:0}.user-editor-enter-from .user-editor-dialog,.user-editor-leave-to .user-editor-dialog{transform:translateY(7px)}@media(max-width:650px){.users-settings{padding:18px}.users-table{min-width:650px}.editor-form{grid-template-columns:1fr}.capability-fieldset,.editor-hint,.editor-error,.editor-form footer{grid-column:1}.capability-fieldset{grid-template-columns:1fr}}
.user-notice{position:fixed;z-index:10020;top:24px;left:50%;transform:translateX(-50%);display:flex;align-items:flex-start;gap:10px;box-sizing:border-box;width:max-content;max-width:min(520px,calc(100vw - 32px));padding:12px 14px;border:1px solid #e1e6ee;border-radius:8px;background:#fff;color:#b42318;box-shadow:0 8px 28px rgba(20,29,43,.16);font-size:13px;line-height:1.5}.user-notice.success{color:#18774f}.user-notice>span{min-width:0;overflow-wrap:anywhere;max-height:30vh;overflow-y:auto}.user-notice-icon{flex:0 0 20px;width:20px;height:20px}.user-notice-close{flex:0 0 22px;width:22px;height:22px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}.user-notice-close:focus-visible{outline:2px solid currentColor;outline-offset:2px}.user-notice-enter-active,.user-notice-leave-active{transition:opacity .16s ease}.user-notice-enter-from,.user-notice-leave-to{opacity:0}
@media(prefers-reduced-motion:reduce){.user-notice-enter-active,.user-notice-leave-active{transition:none}}
</style>
