const form = document.getElementById('form'), error = document.getElementById('error');
window.deployment.load().then(({ config, error: message }) => {
    document.getElementById('backendOrigin').value = config.backendOrigin || 'http://127.0.0.1:3001';
    error.textContent = message || '';
}).catch(reason => { error.textContent = reason.message; });
form.addEventListener('submit', async event => {
    event.preventDefault();
    document.getElementById('save').disabled = true;
    try {
        const result = await window.deployment.save({ mode: 'client', backendOrigin: document.getElementById('backendOrigin').value });
        if (!result.success) throw new Error(result.error);
    } catch (reason) { error.textContent = reason.message; document.getElementById('save').disabled = false; }
});
