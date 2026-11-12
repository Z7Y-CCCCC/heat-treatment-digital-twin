const mode = document.getElementById('mode');
function renderMode() { document.getElementById('remote').hidden = mode.value !== 'client'; document.getElementById('backendOrigin').required = mode.value === 'client'; }
mode.addEventListener('change', renderMode);
const form = document.getElementById('form'), error = document.getElementById('error');
let healthTimer = null, generation = 0, disposed = false;
const healthPanel = document.getElementById('connectionHealth');
const ageText = ms => ms == null ? '暂无通信' : ms < 1000 ? '刚刚' : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒前` : `${Math.floor(ms / 60000)} 分钟前`;
function renderHealth(result) {
    healthPanel.dataset.state = result.state;
    document.getElementById('transport').textContent = result.transport || '未检测';
    const link = result.display;
    document.getElementById('displayLink').dataset.state = link?.status || 'unknown';
    document.getElementById('displayLink').textContent = !link ? result.state === 'independent' ? '不适用' : '状态未知' : link.status === 'online'
        ? `${link.connectedClients} 个在线${link.sceneReadyClients ? ' · 场景就绪' : ' · 场景加载中'}` : link.status === 'stale' ? '通信超时' : link.status === 'offline' ? '未连接大屏' : '状态未知';
    document.getElementById('collection').textContent = result.collection || '未获取到数据状态';
    document.getElementById('healthNote').textContent = (result.message || '') + (link ? ` 最近大屏通信：${ageText(link.ageMs)}。` : '')
        + (result.lastSampleAgeMs != null ? ` 最近采样：${ageText(result.lastSampleAgeMs)}。` : '');
    document.getElementById('healthChecked').textContent = `检测当前填写地址${result.latencyMs != null ? ` · 耗时 ${result.latencyMs} ms` : ''}${result.checkedAt ? ` · ${new Date(result.checkedAt).toLocaleTimeString('zh-CN')}` : ''} · 每 3 秒刷新；修改地址需保存重启才生效`;
}
async function checkConnection() {
    clearTimeout(healthTimer);
    const current = ++generation;
    try {
        const result = await window.deployment.probe({ mode:mode.value, backendOrigin:document.getElementById('backendOrigin').value });
        if (!disposed && current === generation) renderHealth(result);
    } catch {
        if (!disposed && current === generation) renderHealth({ state:'offline', transport:'检测失败', collection:'状态未知', message:'未获取到最新状态，不沿用旧的正常状态。' });
    } finally {
        if (!disposed && current === generation) healthTimer = setTimeout(checkConnection, 3000);
    }
}
function scheduleCheck() {
    ++generation; clearTimeout(healthTimer);
    renderHealth({state:'checking', transport:'正在检测…', collection:'等待检测', message:'正在检测当前填写地址，不沿用上一个地址的连接状态。'});
    healthTimer=setTimeout(checkConnection,400);
}
document.getElementById('checkConnection').addEventListener('click', checkConnection);
document.getElementById('backendOrigin').addEventListener('input', scheduleCheck);
mode.addEventListener('change', scheduleCheck);
window.addEventListener('pagehide', () => { disposed=true; ++generation; clearTimeout(healthTimer); });
window.deployment.load().then(({ config, error: message }) => {
    mode.value = config.mode === 'client' ? 'client' : 'display'; renderMode();
    document.getElementById('backendOrigin').value = config.backendOrigin || 'http://127.0.0.1:3001';
    error.textContent = message || '';
    void checkConnection();
}).catch(reason => { error.textContent = reason.message; });
form.addEventListener('submit', async event => {
    event.preventDefault();
    document.getElementById('save').disabled = true;
    try {
        const result = await window.deployment.save({ mode: mode.value, backendOrigin: document.getElementById('backendOrigin').value });
        if (!result.success) throw new Error(result.error);
    } catch (reason) { error.textContent = reason.message; document.getElementById('save').disabled = false; }
});
