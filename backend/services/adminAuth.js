const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_IDLE_MINUTES = 30;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

function authError(statusCode, code, message, retryAfterSeconds = 0) {
    return Object.assign(new Error(message), { statusCode, code, retryAfterSeconds });
}

function equalSecret(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !password.trim()) {
        throw authError(400, 'ADMIN_PASSWORD_FORMAT', '后台密码需为 8–128 个字符，不能全为空格');
    }
}

function validateIdleMinutes(value) {
    if (!Number.isInteger(value) || value < 1 || value > 480) {
        throw authError(400, 'ADMIN_IDLE_FORMAT', '自动锁定时间需为 1–480 分钟的整数');
    }
    return value;
}

function createAdminAuth(options = {}) {
    const dataDir = options.dataDir || process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
    const filename = path.join(path.resolve(dataDir), 'admin-security.json');
    const now = options.now || Date.now;
    const maxSessionMs = options.maxSessionMs || MAX_SESSION_MS;
    // The desktop runs one backend process. Bounded, expiring sessions deliberately
    // stay in memory: restarting the software revokes every engineer session.
    const sessions = new Map();
    const attempts = new Map();
    let passwordOperationBusy = false;
    let sessionGeneration = 0;
    let config = { version: 1, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, password: null };

    if (fs.existsSync(filename)) {
        try {
            const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (stored.version !== 1 || !/^[a-f0-9]{32}$/.test(stored.password?.salt || '')
                || !/^[a-f0-9]{128}$/.test(stored.password?.hash || '')) throw new Error('Invalid credential');
            validateIdleMinutes(stored.idleTimeoutMinutes);
            config = stored;
        } catch {
            // Never turn a damaged credential file into an unprotected first run.
            throw authError(503, 'ADMIN_CONFIG_UNAVAILABLE', '后台安全配置无法读取，请联系工程师恢复安全配置；大屏仍可正常查看');
        }
    }

    function saveConfig(nextConfig) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const temporary = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(nextConfig, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, filename);
            config = nextConfig;
        } catch {
            try { fs.unlinkSync(temporary); } catch { /* no temporary file to remove */ }
            throw authError(503, 'ADMIN_CONFIG_UNAVAILABLE', '无法保存后台安全配置，请检查应用数据目录的写入权限');
        }
    }

    function settings() {
        return {
            idleTimeoutMinutes: config.idleTimeoutMinutes,
            minIdleMinutes: 1,
            maxIdleMinutes: 480,
            maxSessionHours: maxSessionMs / (60 * 60 * 1000)
        };
    }

    function tokenKey(token) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return '';
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    function sessionExpiry(session) {
        return Math.min(session.absoluteExpiresAt, session.lastActivityAt + config.idleTimeoutMinutes * 60000);
    }

    function prune() {
        const time = now();
        for (const [key, session] of sessions) {
            if (time >= sessionExpiry(session)) sessions.delete(key);
        }
        for (const [key, attempt] of attempts) {
            if (time >= attempt.resetAt) attempts.delete(key);
        }
    }

    function getSession(token) {
        prune();
        return sessions.get(tokenKey(token)) || null;
    }

    function status(token) {
        const session = getSession(token);
        return {
            success: true,
            configured: !!config.password,
            authenticated: !!session,
            ...settings(),
            ...(session ? {
                csrfToken: session.csrfToken,
                expiresAt: sessionExpiry(session),
                absoluteExpiresAt: session.absoluteExpiresAt
            } : {})
        };
    }

    function requireSession(token, csrfToken, { touch = false, checkCsrf = true } = {}) {
        const session = getSession(token);
        if (!session) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已锁定，请输入后台密码解锁');
        if (checkCsrf && !equalSecret(csrfToken, session.csrfToken)) {
            throw authError(403, 'ADMIN_CSRF_INVALID', '安全校验已失效，请刷新页面后重试');
        }
        if (touch) session.lastActivityAt = now();
        return session;
    }

    function issueSession(previousToken) {
        prune();
        sessions.delete(tokenKey(previousToken));
        while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(tokenKey(token), {
            csrfToken: crypto.randomBytes(32).toString('hex'),
            lastActivityAt: now(),
            absoluteExpiresAt: now() + maxSessionMs
        });
        return { token, status: status(token) };
    }

    async function hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, SCRYPT_OPTIONS);
        return { salt, hash: hash.toString('hex') };
    }

    async function verifyPassword(password, key) {
        const expected = config.password;
        const hash = await scrypt(password, Buffer.from(expected.salt, 'hex'), 64, SCRYPT_OPTIONS);
        if (!equalSecret(hash.toString('hex'), expected.hash)) {
            const entry = attempts.get(key) || { count: 0, resetAt: now() + 60000 };
            entry.count += 1;
            attempts.set(key, entry);
            if (entry.count >= 5) {
                throw authError(429, 'ADMIN_RATE_LIMITED', '密码连续输入错误，请稍后再试', Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)));
            }
            throw authError(401, 'ADMIN_PASSWORD_INVALID', '后台密码不正确');
        }
        attempts.delete(key);
    }

    async function passwordOperation(key, operation) {
        prune();
        const entry = attempts.get(key);
        if (entry?.count >= 5) {
            throw authError(429, 'ADMIN_RATE_LIMITED', '密码尝试过于频繁，请稍后再试', Math.max(1, Math.ceil((entry.resetAt - now()) / 1000)));
        }
        if (passwordOperationBusy) throw authError(429, 'ADMIN_RATE_LIMITED', '正在验证密码，请稍后再试', 1);
        if (attempts.size >= 256 && !attempts.has(key)) {
            throw authError(429, 'ADMIN_RATE_LIMITED', '密码尝试过于频繁，请稍后再试', 60);
        }
        passwordOperationBusy = true;
        try { return await operation(); }
        finally { passwordOperationBusy = false; }
    }

    return {
        status,
        requireSession,
        async setup(password, key, previousToken) {
            validatePassword(password);
            return passwordOperation(key, async () => {
                if (config.password) throw authError(409, 'ADMIN_ALREADY_CONFIGURED', '后台密码已设置，请使用密码解锁');
                const credential = await hashPassword(password);
                saveConfig({ ...config, password: credential });
                return issueSession(previousToken);
            });
        },
        async login(password, key, previousToken) {
            validatePassword(password);
            return passwordOperation(key, async () => {
                if (!config.password) throw authError(409, 'ADMIN_SETUP_REQUIRED', '请先由工程师设置后台密码');
                const generation = sessionGeneration;
                await verifyPassword(password, key);
                if (generation !== sessionGeneration) {
                    throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已被锁定，请重新输入后台密码解锁');
                }
                return issueSession(previousToken);
            });
        },
        touch(token, csrfToken) {
            requireSession(token, csrfToken, { touch: true });
            return status(token);
        },
        lock(token, csrfToken) {
            if (getSession(token)) {
                requireSession(token, csrfToken);
                // One explicit lock revokes all browser/WebView engineer windows.
                sessionGeneration += 1;
                sessions.clear();
            } else if (sessions.size > 0) {
                throw authError(401, 'ADMIN_AUTH_REQUIRED', '当前会话已失效，无法确认其他窗口已锁定；请重新解锁后再次锁定');
            }
            return status('');
        },
        updateSettings(token, csrfToken, idleTimeoutMinutes) {
            validateIdleMinutes(idleTimeoutMinutes);
            requireSession(token, csrfToken, { touch: true });
            saveConfig({ ...config, idleTimeoutMinutes });
            return status(token);
        },
        async changePassword(token, csrfToken, currentPassword, newPassword, key) {
            validatePassword(currentPassword);
            validatePassword(newPassword);
            if (currentPassword === newPassword) throw authError(400, 'ADMIN_PASSWORD_UNCHANGED', '新密码不能与原密码相同');
            requireSession(token, csrfToken);
            return passwordOperation(key, async () => {
                await verifyPassword(currentPassword, key);
                const credential = await hashPassword(newPassword);
                // Locking in another window while hashing must cancel this change.
                requireSession(token, csrfToken);
                saveConfig({ ...config, password: credential });
                sessionGeneration += 1;
                sessions.clear();
                return issueSession();
            });
        }
    };
}

let instance;
function getAdminAuth() {
    instance ||= createAdminAuth();
    return instance;
}

module.exports = { authError, createAdminAuth, equalSecret, getAdminAuth, MAX_SESSION_MS };
