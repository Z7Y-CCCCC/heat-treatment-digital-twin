<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
const props = defineProps({ draft: { type: Object, required: true }, section: { type: String, default: 'connection' }, permissionPage: { type: String, default: 'settings.database' }, busy: Boolean })
const emit = defineEmits(['upload-state'])
const http = computed(() => props.draft.sourceType === 'http_api')
const kind = computed(() => props.draft.connector || 'http')
const sqlite = computed(() => !http.value && props.draft.type === 'sqlite')
const uploading = ref(false), uploadMessage = ref('')
let disposed = false
onBeforeUnmount(() => { disposed = true })
async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || props.busy || uploading.value) return
    if (file.size > 1048576) { uploadMessage.value = '文件不能超过 1 MB'; return }
    uploading.value = true; emit('upload-state', true); uploadMessage.value = '正在导入…'
    try {
        const result = await adminApi.importDataSourceFile(file)
        if (disposed) return
        props.draft.baseUrl = result.file.asset
        if (!props.draft.name) props.draft.name = file.name.replace(/\.[^.]+$/, '')
        uploadMessage.value = file.name + ' · 已导入'
    } catch (error) { if (!disposed) uploadMessage.value = error.message || '导入失败' }
    finally { uploading.value = false; emit('upload-state', false) }
}
</script>

<template>
    <fieldset class="source-form" :disabled="busy || uploading" v-permission="{ page: permissionPage, action: 'edit' }">
        <div v-show="section === 'connection'" class="source-fields">
            <label class="wide">数据源名称<input v-model="draft.name" class="input" placeholder="例如：MES 生产数据库" maxlength="100" /></label>
            <template v-if="http && kind === 'file'">
                <label class="wide">数据文件<input type="file" class="input" accept=".csv,.json,text/csv,application/json" aria-label="导入 CSV / JSON 文件" @change="importFile" /></label>
                <p class="hint wide">{{ uploadMessage || (draft.baseUrl ? '已有导入文件；重新选择可替换。' : '导入 1 MB 以内的 CSV / JSON，保存副本，不读取任意系统文件。') }}</p>
            </template>
            <template v-else-if="http && kind !== 'http'">
                <label class="wide">接入地址<input v-model="draft.baseUrl" class="input" :placeholder="({ websocket: 'wss://HOST/telemetry', mqtt: 'mqtt://HOST:1883', tcp: 'tcp://HOST:PORT', udp: 'udp://0.0.0.0:PORT', redis: 'redis://HOST:6379/0' })[kind]" /></label>
                <label v-if="['mqtt', 'redis'].includes(kind)" class="wide">{{ kind === 'mqtt' ? '订阅主题' : 'Redis 键名' }}<input v-model="draft.healthPath" class="input" :aria-label="kind === 'mqtt' ? '订阅主题' : 'Redis 键名'" /></label>
                <p class="hint wide">{{ ({ websocket: '接收服务端主动推送的数据，不发送业务命令。', mqtt: '只读订阅，按需取样；不发布消息，不保存历史。', tcp: '接收完整 JSON 或换行分隔帧，不发送控制指令。', udp: '本机 UDP 接收模式；发送端需向本机此端口发送数据。', redis: '使用 PING 与有大小限制的 GETRANGE 读取字符串键，不执行写入命令。' })[kind] }}</p>
            </template>
            <template v-else-if="http">
                <label class="wide">API 根地址<input v-model="draft.baseUrl" class="input" placeholder="https://mes.example.com/api" /></label>
                <label>健康检查地址<input v-model="draft.healthPath" class="input" placeholder="/health" /></label>
                <label>响应格式<select v-model="draft.responseFormat" class="input" aria-label="响应格式"><option value="auto">自动识别</option><option value="json">JSON / OData JSON</option><option value="xml">XML</option><option value="csv">CSV</option></select></label>

            </template>
            <template v-else-if="sqlite">
                <label class="wide">SQLite 文件<input v-model="draft.filename" class="input" placeholder="完整 .db 文件路径" /></label>
                <p class="hint wide">读取后台所在电脑上的数据库文件，不改变主库。</p>
            </template>
            <template v-else>
                <label>主机<input v-model="draft.host" class="input" placeholder="127.0.0.1" /></label>
                <label>端口<input v-model.number="draft.port" class="input" type="number" min="1" max="65535" /></label>
                <label class="wide">数据库名<input v-model="draft.database" class="input" placeholder="数据库名称" /></label>
            </template>
        </div>
        <div v-show="section === 'authentication'" class="source-fields">
            <p v-if="sqlite || http && ['file', 'tcp', 'udp'].includes(kind)" class="hint wide">此接入使用本机文件 / 网络权限，无需账号密码。</p>
            <template v-else>
                <label v-if="http" class="wide">认证方式<select v-model="draft.authType" class="input" aria-label="认证方式"><option value="none">无认证</option><option v-if="kind === 'http'" value="login_token">登录接口取 Token</option><option v-if="kind === 'http'" value="api_key">API Key</option><option v-if="['http', 'websocket'].includes(kind)" value="bearer">Bearer Token</option><option value="basic">用户名密码</option><option v-if="kind === 'http'" value="oauth2_client_credentials">OAuth2 客户端凭据</option></select></label>
                <template v-if="!http || ['basic','login_token'].includes(draft.authType)">
                    <label>{{ http ? '用户名' : '只读账号' }}<input v-model="draft.user" class="input" autocomplete="off" /></label>
                    <label>密码<input v-model="draft.password" type="password" class="input" autocomplete="new-password" /></label>
                </template>
                <template v-if="http && draft.authType === 'api_key'">
                    <label>API Key 请求头<input v-model="draft.apiKeyHeader" class="input" placeholder="X-API-Key" /></label>
                    <label>API Key<input v-model="draft.apiKey" type="password" class="input" autocomplete="new-password" /></label>
                </template>
                <label v-if="http && draft.authType === 'bearer'" class="wide">Bearer Token<input v-model="draft.token" type="password" class="input" autocomplete="new-password" /></label>
                <template v-if="http && draft.authType === 'login_token'">
                    <label class="wide">登录路径<input v-model="draft.loginPath" class="input" placeholder="/auth/login" aria-label="登录接口路径" /></label>
                    <label>账号字段名<input v-model="draft.loginUserField" class="input" placeholder="username" /></label><label>密码字段名<input v-model="draft.loginPasswordField" class="input" placeholder="password" /></label>
                    <label>登录请求格式<select v-model="draft.loginBodyFormat" class="input"><option value="json">JSON</option><option value="form">Form</option></select></label><label>Token 字段路径<input v-model="draft.tokenPath" class="input" placeholder="data.token" /></label>
                    <label>Token 请求头<input v-model="draft.tokenHeader" class="input" placeholder="Authorization" /></label><label>Token 前缀<input v-model="draft.tokenPrefix" class="input" placeholder="Bearer，可留空" /></label>
                    <label>Token 缓存（秒）<input v-model.number="draft.tokenLifetimeSec" class="input" type="number" min="10" max="86400" /></label>
                </template>
                <template v-if="http && draft.authType === 'oauth2_client_credentials'">
                    <label class="wide">令牌地址（HTTPS）<input v-model="draft.tokenUrl" class="input" placeholder="https://login.example.com/oauth2/token" /></label>
                    <label>Client ID<input v-model="draft.clientId" class="input" autocomplete="off" /></label>
                    <label>Client Secret<input v-model="draft.clientSecret" type="password" class="input" autocomplete="new-password" /></label>
                    <label>Scope（可选）<input v-model="draft.scope" class="input" /></label>
                    <label>客户端认证方式<select v-model="draft.tokenAuthMethod" class="input" aria-label="客户端认证方式"><option value="body">表单参数</option><option value="basic">HTTP Basic</option></select></label>
                </template>
                <p v-if="!http || draft.authType !== 'none'" class="hint wide">掩码不改则保留；输入新值替换，清空则删除凭据。</p>
            </template>
        </div>
        <div v-show="section === 'advanced'" class="source-fields">
            <label v-if="http">请求超时（毫秒）<input v-model.number="draft.requestTimeoutMs" class="input" type="number" min="1000" max="60000" /></label>
            <label v-else>查询超时（毫秒）<input v-model.number="draft.queryTimeoutMs" class="input" type="number" min="1000" max="60000" /></label>
            <label v-if="!http && ['postgres', 'sqlserver'].includes(draft.type)">默认 Schema<input v-model="draft.defaultSchema" class="input" :placeholder="draft.type === 'postgres' ? 'public' : 'dbo'" /></label>
            <label class="check"><input v-model="draft.enabled" type="checkbox" />启用此连接</label>
            <template v-if="!http && draft.type === 'sqlserver'">
                <label class="check"><input v-model="draft.encrypt" type="checkbox" />加密连接</label>
                <label class="check"><input v-model="draft.trustServerCertificate" type="checkbox" />信任服务器证书</label>
                <p class="hint wide">仅在可信内网且无法部署有效证书时开启“信任服务器证书”。</p>
            </template>
        </div>
    </fieldset>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
* { box-sizing: border-box; }
.source-form { min-width: 0; padding: 0; margin: 0; border: 0; }
.source-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 22px; padding:21px 0; }
label { display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: #536176; min-width: 0; }
.input { width: 100%; min-width: 0; font: inherit; min-height:36px; border-color:#dce1e8; background:#fff; border-radius:6px; color:#344054; }
.wide { grid-column: 1 / -1; }
.check { flex-direction: row; align-items: center; align-self: end; min-height:36px; border-color:#dce1e8; background:#fff; border-radius:6px; color:#344054; }
.hint { margin: 0; color: #8490a1; font-size: 12px; line-height: 1.6; }
@media(max-width: 700px) { .source-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
