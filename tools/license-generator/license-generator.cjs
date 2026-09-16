#!/usr/bin/env node

/*
 * Local-only license issuer.
 * The private key is created and kept beside this tool. It is never served to
 * the browser and is never included in a customer license document.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const { signLicensePayload, normalizePayload, LICENSE_FORMAT, LICENSE_VERSION, LICENSE_ALGORITHM } = require('../../backend/services/license');

const TOOL_DIR = __dirname;
const ISSUED_DIR = path.join(TOOL_DIR, 'issued');
const PRIVATE_KEY_FILE = path.join(TOOL_DIR, 'license-private-key.pem');
const PUBLIC_KEY_FILE = path.join(TOOL_DIR, 'license-public-key.pem');
const UI_FILE = path.join(TOOL_DIR, 'index.html');
const HOST = '127.0.0.1';
const ACCESS_TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 128 * 1024;

fs.mkdirSync(ISSUED_DIR, { recursive: true });

function json(res, statusCode, value) {
    const body = JSON.stringify(value);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
    });
    res.end(body);
}

function publicKeyFingerprint() {
    if (!fs.existsSync(PUBLIC_KEY_FILE)) return null;
    try {
        const key = crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY_FILE));
        return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    } catch (error) {
        return null;
    }
}

function keyStatus() {
    return {
        privateKeyPresent: fs.existsSync(PRIVATE_KEY_FILE),
        publicKeyPresent: fs.existsSync(PUBLIC_KEY_FILE),
        publicKeyFingerprint: publicKeyFingerprint(),
        publicKeyFile: PUBLIC_KEY_FILE,
        issuedDirectory: ISSUED_DIR
    };
}

function writePrivateFile(file, value) {
    fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (error) { /* Windows ACLs are managed by the owner. */ }
}

function generateKeys(overwrite = false) {
    if (!overwrite && (fs.existsSync(PRIVATE_KEY_FILE) || fs.existsSync(PUBLIC_KEY_FILE))) {
        const error = new Error('密钥文件已存在；如需替换请明确选择“覆盖密钥对”。');
        error.code = 'KEY_EXISTS';
        throw error;
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    writePrivateFile(PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }), { encoding: 'utf8', mode: 0o644 });
    return keyStatus();
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('请求内容过大'), { code: 'BODY_TOO_LARGE' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (error) { reject(new Error('请求不是有效 JSON')); }
        });
        req.on('error', reject);
    });
}

function safeLicenseFileName(licenseId) {
    const safe = String(licenseId || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return `license-${safe || 'unnamed'}-${Date.now()}.json`;
}

function validatePayload(input) {
    const payload = normalizePayload(input || {});
    if (!payload.licenseId || !payload.customer || !payload.issuedAt || !payload.expiresAt) {
        throw new Error('许可证编号、客户名称、生效时间、失效时间均不能为空。');
    }
    const issued = Date.parse(payload.issuedAt);
    const expires = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
        throw new Error('许可证日期无效，且失效时间必须晚于生效时间。');
    }
    if (payload.machineId && !/^machine-[a-f0-9]{32}$/i.test(payload.machineId)) {
        throw new Error('机器指纹格式不正确，请从客户机后台复制完整指纹。');
    }
    return payload;
}

function isAuthorized(requestUrl) {
    return requestUrl.searchParams.get('token') === ACCESS_TOKEN;
}

function serveUi(res) {
    const body = fs.readFileSync(UI_FILE);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${HOST}`);
    if (!isAuthorized(requestUrl)) {
        json(res, 401, { success: false, error: '本地授权工具访问令牌无效。' });
        return;
    }
    try {
        if (req.method === 'GET' && requestUrl.pathname === '/') {
            serveUi(res);
            return;
        }
        if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
            json(res, 200, { success: true, ...keyStatus(), format: LICENSE_FORMAT, version: LICENSE_VERSION, algorithm: LICENSE_ALGORITHM });
            return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/api/generate-keys') {
            const body = await readBody(req);
            json(res, 200, { success: true, ...generateKeys(Boolean(body.overwrite)) });
            return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/api/sign') {
            if (!fs.existsSync(PRIVATE_KEY_FILE)) throw new Error('尚未生成密钥对，请先生成密钥。');
            const body = await readBody(req);
            const payload = validatePayload(body.payload || body);
            const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE));
            const license = signLicensePayload(payload, privateKey);
            const fileName = safeLicenseFileName(payload.licenseId);
            const filePath = path.join(ISSUED_DIR, fileName);
            fs.writeFileSync(filePath, `${JSON.stringify(license, null, 2)}\n`, 'utf8');
            json(res, 200, { success: true, fileName, license });
            return;
        }
        if (req.method === 'GET' && requestUrl.pathname === '/api/download') {
            const fileName = path.basename(requestUrl.searchParams.get('file') || '');
            if (!/^license-[a-zA-Z0-9._-]+\.json$/.test(fileName)) {
                json(res, 400, { success: false, error: '文件名无效。' });
                return;
            }
            const filePath = path.join(ISSUED_DIR, fileName);
            if (!fs.existsSync(filePath)) {
                json(res, 404, { success: false, error: '许可证文件不存在。' });
                return;
            }
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'content-disposition': `attachment; filename="${fileName}"`,
                'cache-control': 'no-store'
            });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        json(res, 404, { success: false, error: '接口不存在。' });
    } catch (error) {
        const statusCode = error.code === 'KEY_EXISTS' ? 409 : error.code === 'BODY_TOO_LARGE' ? 413 : 400;
        json(res, statusCode, { success: false, code: error.code || 'REQUEST_FAILED', error: error.message });
    }
});

server.listen(Number(process.env.LICENSE_GENERATOR_PORT || 0), HOST, () => {
    const address = server.address();
    const url = `http://${HOST}:${address.port}/?token=${ACCESS_TOKEN}`;
    console.log(`许可证签发工具已启动：${url}`);
    console.log(`私钥文件：${PRIVATE_KEY_FILE}`);
    console.log(`公钥文件：${PUBLIC_KEY_FILE}`);
    console.log('请只把公钥部署到客户机，私钥不要发送给客户。');
    if (process.platform === 'win32') {
        execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    }
});

function stop() {
    server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
