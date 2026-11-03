const fs = require('node:fs');
const path = require('node:path');

function httpOrigin(value, label) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${label}必须填写完整的 http:// 或 https:// 地址`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${label}只填写服务器地址和端口，不含账号、路径或查询参数`);
    }
    return url.origin;
}

function normalizeDeployment(raw = {}) {
    const mode = raw.mode || 'local';
    if (!['local', 'display', 'client'].includes(mode)) throw new Error('未知部署模式');
    if (mode === 'local' || mode === 'display') return { mode };
    if (mode === 'client') return { mode, backendOrigin: httpOrigin(raw.backendOrigin, '采集服务地址') };
    throw new Error('未知部署模式');
}

function deploymentFile(root, argv = process.argv, env = process.env) {
    const argument = argv.find(value => value.startsWith('--deployment-config='));
    return path.resolve(argument?.slice('--deployment-config='.length) || env.DIGITAL_TWIN_DEPLOYMENT_FILE
        || path.join(root, 'deployment.json'));
}

function readDeployment(filename) {
    if (!fs.existsSync(filename)) return { mode: 'local' };
    try { return normalizeDeployment(JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))); }
    catch (error) { throw new Error(`部署配置无法读取：${filename}\n${error.message}`); }
}

async function saveDeployment(filename, value) {
    const config = normalizeDeployment(value);
    await fs.promises.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporary, filename);
    return config;
}

function resolveDeployment(root, options = {}) {
    const env = options.env || process.env, argv = options.argv || process.argv;
    const filename = deploymentFile(root, argv, env);
    const machineFile = env.DIGITAL_TWIN_COLLECTOR_CONFIG || path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData',
        'HeatTreatmentDigitalTwin', 'collector-service.json');
    const machineClient = () => {
        const service = JSON.parse(fs.readFileSync(machineFile, 'utf8').replace(/^\uFEFF/, ''));
        return normalizeDeployment({ mode: 'client', backendOrigin: service.backendOrigin });
    };
    if (fs.existsSync(filename)) {
        const config = readDeployment(filename);
        // Once a machine collector is installed, development and packaged Unity
        // must not silently edit a second local database. Smoke fixtures opt out.
        if (config.mode === 'local' && env.DESKTOP_SMOKE_STANDALONE !== 'true' && fs.existsSync(machineFile)) return machineClient();
        return config;
    }
    if (env.DESKTOP_SMOKE_STANDALONE === 'true') return { mode: 'local' };
    if (fs.existsSync(machineFile)) return machineClient();
    // A display-only installation owns its configuration/API but no PLC reader.
    // An existing collector remains authoritative even when temporarily stopped;
    // never silently fork its database or lose its accounts/activation.
    return { mode: 'local' };
}

function desktopMachineIdentityFile(root, env = process.env) {
    const legacy = path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'HeatTreatmentDigitalTwin', 'machine-identity.json');
    return fs.existsSync(legacy) || fs.existsSync(`${legacy}.bak`) ? legacy : path.join(root, 'machine-identity.json');
}
module.exports = { deploymentFile, httpOrigin, normalizeDeployment, readDeployment, resolveDeployment, saveDeployment, desktopMachineIdentityFile };
