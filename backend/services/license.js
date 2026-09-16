const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const LICENSE_FILE = path.resolve(process.env.LICENSE_FILE || path.join(DATA_DIR, 'license.json'));
const MACHINE_STATE_FILE = path.resolve(process.env.LICENSE_MACHINE_STATE_FILE || (
    process.platform === 'win32'
        ? path.join(process.env.PROGRAMDATA || path.join(os.homedir(), 'AppData', 'Local'), 'HeatTreatmentDigitalTwin', 'machine-identity.json')
        : path.join(DATA_DIR, 'machine-identity.json')
));
const MACHINE_STATE_BACKUP_FILE = `${MACHINE_STATE_FILE}.bak`;
const LICENSE_FORMAT = 'heat-treatment-digital-twin-license';
const LICENSE_VERSION = 1;
const LICENSE_ALGORITHM = 'ed25519';
let localMachineCache = null;

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4;
    return Buffer.from(normalized + (padding ? '='.repeat(4 - padding) : ''), 'base64');
}

function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function normalizePayload(payload = {}) {
    const features = Array.isArray(payload.features)
        ? [...new Set(payload.features.map(value => String(value || '').trim()).filter(Boolean))].sort()
        : [];
    return {
        licenseId: String(payload.licenseId || '').trim(),
        customer: String(payload.customer || '').trim(),
        issuedAt: String(payload.issuedAt || '').trim(),
        expiresAt: String(payload.expiresAt || '').trim(),
        features,
        machineId: String(payload.machineId || '').trim() || null,
        deviceLimit: Number.isFinite(Number(payload.deviceLimit)) && Number(payload.deviceLimit) > 0
            ? Math.floor(Number(payload.deviceLimit))
            : null
    };
}

function readHardwareIdentities() {
    const identities = [];
    const add = (value, source) => {
        const normalized = String(value || '').trim();
        if (normalized && !identities.some(item => item.value === normalized)) identities.push({ value: normalized, source });
    };
    try {
        if (process.platform === 'win32') {
            const output = execFileSync('reg', [
                'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
            ], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
            if (match?.[1]?.trim()) add(match[1], 'Windows MachineGuid');
        }
        if (process.platform === 'linux') {
            add(fs.readFileSync('/etc/machine-id', 'utf8'), 'Linux machine-id');
        }
        if (process.platform === 'darwin') {
            const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
                encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
            });
            const match = output.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (match?.[1]?.trim()) add(match[1], 'macOS IOPlatformUUID');
        }
    } catch (error) {
        // Hardware queries are best-effort. The persistent installation anchor
        // below is the primary binding, so a transient query failure does not
        // invalidate an otherwise healthy installation.
    }
    add([os.hostname(), os.platform(), os.arch()].filter(Boolean).join('|'), '本机环境回退标识');
    return identities;
}

function readInstallationIdFile(filename) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (parsed?.version === 1 && typeof parsed.installationId === 'string' && parsed.installationId.trim()) {
            return parsed.installationId.trim();
        }
    } catch (error) {
        // The caller tries the atomic backup before generating a new anchor.
    }
    return null;
}

function writeInstallationIdFile(filename, installationId) {
    const state = JSON.stringify({ version: 1, installationId, createdAt: new Date().toISOString() }, null, 2) + '\n';
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, state, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filename);
}

function readPersistentInstallationId() {
    const primary = readInstallationIdFile(MACHINE_STATE_FILE);
    if (primary) {
        try {
            if (!readInstallationIdFile(MACHINE_STATE_BACKUP_FILE)) writeInstallationIdFile(MACHINE_STATE_BACKUP_FILE, primary);
        } catch (error) {
            // The primary identity is still valid if the backup cannot be refreshed.
        }
        return primary;
    }
    const backup = readInstallationIdFile(MACHINE_STATE_BACKUP_FILE);
    if (backup) {
        try {
            fs.mkdirSync(path.dirname(MACHINE_STATE_FILE), { recursive: true });
            writeInstallationIdFile(MACHINE_STATE_FILE, backup);
        } catch (error) {
            // Keep using the backup in memory if the primary cannot be restored.
        }
        return backup;
    }

    const installationId = crypto.randomUUID();
    try {
        fs.mkdirSync(path.dirname(MACHINE_STATE_FILE), { recursive: true });
        writeInstallationIdFile(MACHINE_STATE_BACKUP_FILE, installationId);
        writeInstallationIdFile(MACHINE_STATE_FILE, installationId);
        return installationId;
    } catch (error) {
        const recovered = readInstallationIdFile(MACHINE_STATE_FILE) || readInstallationIdFile(MACHINE_STATE_BACKUP_FILE);
        if (recovered) return recovered;
        // Fall back to hardware identifiers when the OS-level state store is
        // unavailable. This keeps the app diagnosable on restricted PCs.
        return null;
    }
}

function hashMachineValue(value) {
    return `machine-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`;
}

function getLocalMachineId() {
    const configured = String(process.env.LICENSE_MACHINE_ID || '').trim();
    if (!configured && localMachineCache && localMachineCache.expiresAt > Date.now()) return localMachineCache.value;
    if (configured) return { id: hashMachineValue(configured), source: '环境变量', available: true, aliases: [] };

    const installationId = readPersistentInstallationId();
    const hardware = readHardwareIdentities();
    const primaryValue = installationId ? `installation:${installationId}` : hardware[0]?.value;
    const primary = primaryValue ? hashMachineValue(primaryValue) : null;
    const aliases = hardware.map(item => hashMachineValue(item.value)).filter(id => id && id !== primary);
    const result = {
        id: primary || null,
        source: installationId ? '持久安装锚点（兼容硬件指纹）' : (hardware[0]?.source || '本机环境回退标识'),
        available: Boolean(primary),
        aliases: [...new Set(aliases)]
    };
    localMachineCache = { value: result, expiresAt: Date.now() + 60 * 1000 };
    return result;
}

function readPublicKey() {
    const configuredFile = String(process.env.LICENSE_PUBLIC_KEY_FILE || '').trim();
    const configuredValue = String(process.env.LICENSE_PUBLIC_KEY || '').trim();
    if (configuredFile) {
        try { return crypto.createPublicKey(fs.readFileSync(path.resolve(configuredFile))); } catch (error) { return null; }
    }
    if (!configuredValue) return null;
    try {
        const material = configuredValue.includes('BEGIN PUBLIC KEY')
            ? configuredValue.replace(/\\n/g, '\n')
            : Buffer.from(configuredValue, 'base64');
        return crypto.createPublicKey(material);
    } catch (error) {
        return null;
    }
}

function loadRawLicense() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return { __readError: error.message };
    }
}

function evaluateLicense(raw = loadRawLicense(), options = {}) {
    const enforce = options.enforce !== undefined
        ? Boolean(options.enforce)
        : process.env.LICENSE_ENFORCE === 'true';
    const publicKey = options.publicKey || readPublicKey();
    const localMachine = getLocalMachineId();
    const result = {
        format: LICENSE_FORMAT,
        version: LICENSE_VERSION,
        file: LICENSE_FILE,
        enforce,
        configured: false,
        valid: false,
        status: 'not_configured',
        reason: '未配置离线许可证',
        licenseId: null,
        customer: null,
        issuedAt: null,
        expiresAt: null,
        features: [],
        machineBound: false,
        machineId: localMachine.id,
        machineIdSource: localMachine.source,
        machineIdAvailable: localMachine.available,
        checkedAt: new Date().toISOString()
    };
    if (!raw) return result;
    if (raw.__readError) {
        result.status = 'invalid';
        result.reason = `许可证文件无法读取：${raw.__readError}`;
        return result;
    }
    result.configured = true;
    if (raw.format !== LICENSE_FORMAT || Number(raw.version) !== LICENSE_VERSION || raw.algorithm !== LICENSE_ALGORITHM) {
        result.status = 'invalid';
        result.reason = '许可证格式或版本不受支持';
        return result;
    }
    const payload = normalizePayload(raw.payload);
    Object.assign(result, {
        licenseId: payload.licenseId || null,
        customer: payload.customer || null,
        issuedAt: payload.issuedAt || null,
        expiresAt: payload.expiresAt || null,
        features: payload.features,
        machineBound: Boolean(payload.machineId)
    });
    if (!payload.licenseId || !payload.customer || !payload.issuedAt || !payload.expiresAt || !raw.signature) {
        result.status = 'invalid';
        result.reason = '许可证缺少必要字段';
        return result;
    }
    if (!publicKey) {
        result.status = 'unverified';
        result.reason = '未配置许可证公钥，无法验证签名';
        return result;
    }
    let signature;
    try { signature = base64UrlDecode(raw.signature); } catch (error) { signature = null; }
    let signatureValid = false;
    try {
        signatureValid = Boolean(signature)
            && crypto.verify(null, Buffer.from(canonicalize(payload)), publicKey, signature);
    } catch (error) {
        signatureValid = false;
    }
    if (!signatureValid) {
        result.status = 'invalid';
        result.reason = '许可证签名校验失败';
        return result;
    }
    const now = Date.now();
    const issued = Date.parse(payload.issuedAt);
    const expires = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
        result.status = 'invalid';
        result.reason = '许可证日期无效';
        return result;
    }
    if (now < issued) {
        result.status = 'not_yet_valid';
        result.reason = '许可证尚未到生效时间';
        return result;
    }
    if (now >= expires) {
        result.status = 'expired';
        result.reason = '许可证已过期';
        return result;
    }
    const expectedMachines = new Set([localMachine.id, ...(localMachine.aliases || [])].filter(Boolean));
    if (payload.machineId && !expectedMachines.size) {
        result.status = 'machine_unavailable';
        result.reason = '无法读取本机授权指纹，暂不能验证机器绑定许可证';
        return result;
    }
    if (payload.machineId && !expectedMachines.has(payload.machineId)) {
        result.status = 'machine_mismatch';
        result.reason = '许可证未授权当前安装实例';
        return result;
    }
    result.status = 'valid';
    result.valid = true;
    result.reason = '许可证有效';
    return result;
}

function getLicenseStatus() {
    return evaluateLicense();
}

function isLicenseEnforced() {
    return process.env.LICENSE_ENFORCE === 'true';
}

function assertLicenseForWrite() {
    if (!isLicenseEnforced()) return;
    const status = getLicenseStatus();
    if (!status.valid) {
        const error = new Error(`当前许可证不可用：${status.reason}`);
        error.code = 'LICENSE_REQUIRED';
        throw error;
    }
}

function installLicense(document) {
    const raw = document && typeof document === 'object' ? document : null;
    if (!raw) throw new Error('许可证内容必须是 JSON 对象');
    const status = evaluateLicense(raw);
    if (status.status !== 'valid') throw new Error(`许可证校验失败：${status.reason}`);
    fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
    const temporary = `${LICENSE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, LICENSE_FILE);
    return getLicenseStatus();
}

function signLicensePayload(payload, privateKey) {
    const normalized = normalizePayload(payload);
    const signature = crypto.sign(null, Buffer.from(canonicalize(normalized)), privateKey);
    return {
        format: LICENSE_FORMAT,
        version: LICENSE_VERSION,
        algorithm: LICENSE_ALGORITHM,
        payload: normalized,
        signature: base64UrlEncode(signature)
    };
}

module.exports = {
    LICENSE_FILE,
    LICENSE_FORMAT,
    LICENSE_VERSION,
    LICENSE_ALGORITHM,
    canonicalize,
    evaluateLicense,
    getLicenseStatus,
    installLicense,
    isLicenseEnforced,
    assertLicenseForWrite,
    signLicensePayload,
    normalizePayload,
    getLocalMachineId
};
