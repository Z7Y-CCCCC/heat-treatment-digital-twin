const mode = document.getElementById('mode');
function renderMode() { document.getElementById('remote').hidden = mode.value !== 'client'; document.getElementById('backendOrigin').required = mode.value === 'client'; }
mode.addEventListener('change', renderMode);
const form = document.getElementById('form'), error = document.getElementById('error');
window.deployment.load().then(({ config, error: message }) => {
    mode.value = config.mode === 'client' ? 'client' : 'display'; renderMode();
    document.getElementById('backendOrigin').value = config.backendOrigin || 'http://127.0.0.1:3001';
    error.textContent = message || '';
}).catch(reason => { error.textContent = reason.message; });
form.addEventListener('submit', async event => {
    event.preventDefault();
    document.getElementById('save').disabled = true;
    try {
        const result = await window.deployment.save({ mode: mode.value, backendOrigin: document.getElementById('backendOrigin').value });
        if (!result.success) throw new Error(result.error);
    } catch (reason) { error.textContent = reason.message; document.getElementById('save').disabled = false; }
});
