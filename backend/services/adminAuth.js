const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_IDLE_MINUTES = 30;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const USER_ROLES = new Set(['customer', 'viewer', 'editor']);
const ASSIGNABLE_USER_ROLES = new Set(['customer', 'viewer']);
const DELEGABLE_PERMISSIONS = ['view', 'launch', 'cast', 'backup'];

function publicRole(role) {
    // Existing installations may still contain editor accounts. They no
    // longer receive platform-edit rights; treat them as on-site customers.
    return role === 'editor' ? 'customer' : role;
}

function permissionsForRole(role) {
    const administrator = role === 'owner';
    const customer = role === 'customer' || role === 'editor';
    return {
        view: administrator || customer || role === 'viewer',
        edit: administrator,
        manageUsers: administrator,
        launch: administrator || customer,
        cast: administrator || customer,
        backup: administrator || customer
    };
}

function normalizeUserPermissions(role, value) {
    const defaults = permissionsForRole(role);
    if (value === undefined) return Object.fromEntries(DELEGABLE_PERMISSIONS.map(key => [key, defaults[key]]));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !DELEGABLE_PERMISSIONS.includes(key) || typeof value[key] !== 'boolean')) {
        throw authError(400, 'ADMIN_USER_PERMISSIONS_FORMAT', '用户功能权限格式无效');
    }
    return Object.fromEntries(DELEGABLE_PERMISSIONS.map(key => [key,
        Object.prototype.hasOwnProperty.call(value, key) ? value[key] : defaults[key]
    ]));
}

function storedUserPermissionsAreValid(value) {
    return value === undefined || Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => DELEGABLE_PERMISSIONS.includes(key) && typeof value[key] === 'boolean'));
}

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
    const nativeTickets = new Map();
    let passwordOperationBusy = false;
    let sessionGeneration = 0;
    let config = { version: 1, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, password: null, users: [] };

    if (fs.existsSync(filename)) {
        try {
            const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (stored.version !== 1 || !/^[a-f0-9]{32}$/.test(stored.password?.salt || '')
                || !/^[a-f0-9]{128}$/.test(stored.password?.hash || '')) throw new Error('Invalid credential');
            validateIdleMinutes(stored.idleTimeoutMinutes);
            if (stored.users !== undefined && (!Array.isArray(stored.users) || stored.users.length > 64
                || stored.users.some(user => !/^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/.test(user.username || '')
                    || !USER_ROLES.has(user.role) || !/^[a-f0-9]{32}$/.test(user.password?.salt || '')
                    || !/^[a-f0-9]{128}$/.test(user.password?.hash || '')
                    || !storedUserPermissionsAreValid(user.permissions)))) throw new Error('Invalid users');
            config = { ...stored, users: stored.users || [] };
        } catch {
            // Never turn a damaged credential file into an unprotected first run.
            throw authError(503, 'ADMIN_CONFIG_UNAVAILABLE', '账户安全配置无法读取，请联系系统管理员恢复安全配置');
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
        for (const [key, ticket] of nativeTickets) {
            if (time >= ticket.expiresAt) nativeTickets.delete(key);
        }
    }

    function getSession(token) {
        prune();
        const key = tokenKey(token);
        const session = sessions.get(key);
        if (!session) return null;
        if (session.userId !== 'owner' && !config.users.some(user => user.id === session.userId && user.enabled !== false)) {
            sessions.delete(key);
            return null;
        }
        return session;
    }

    function principal(session) {
        if (!session) return null;
        if (session.userId === 'owner') return { id: 'owner', username: 'admin', displayName: '系统管理员', role: 'owner' };
        const user = config.users.find(item => item.id === session.userId);
        return user ? { id: user.id, username: user.username, displayName: user.displayName || user.username, role: publicRole(user.role) } : null;
    }

    function permissionsForSession(session) {
        if (!session) return permissionsForRole('');
        if (session.userId === 'owner') return permissionsForRole('owner');
        const user = config.users.find(item => item.id === session.userId);
        return user
            ? { ...permissionsForRole(publicRole(user.role)), ...normalizeUserPermissions(user.role, user.permissions) }
            : permissionsForRole('');
    }

    function status(token) {
        const session = getSession(token);
        return {
            success: true,
            configured: !!config.password,
            authenticated: !!session,
            ...settings(),
            ...(session ? {
                user: principal(session),
                permissions: permissionsForSession(session),
                csrfToken: session.csrfToken,
                expiresAt: sessionExpiry(session),
                absoluteExpiresAt: session.absoluteExpiresAt
            } : {})
        };
    }

    function requireSession(token, csrfToken, { touch = false, checkCsrf = true, permission = 'view' } = {}) {
        const session = getSession(token);
        if (!session) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已锁定，请输入后台密码解锁');
        if (checkCsrf && !equalSecret(csrfToken, session.csrfToken)) {
            throw authError(403, 'ADMIN_CSRF_INVALID', '安全校验已失效，请刷新页面后重试');
        }
        const role = principal(session)?.role;
        const permissions = permissionsForSession(session);
        if ((permission === 'owner' || permission === 'admin' || permission === 'edit') && role !== 'owner'
            || ['launch', 'cast', 'backup', 'view'].includes(permission) && !permissions[permission]) {
            throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有执行此操作的权限');
        }
        if (touch) session.lastActivityAt = now();
        return { ...session, role, userId: session.userId };
    }

    function issueSession(previousToken, userId = 'owner') {
        prune();
        sessions.delete(tokenKey(previousToken));
        while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(tokenKey(token), {
            userId,
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

    async function verifyPassword(password, key, expected = config.password) {
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
        createNativeTicket(token, csrfToken) {
            const session = requireSession(token, csrfToken, { permission: 'launch' });
            if (!permissionsForSession(session).view) {
                throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有查看大屏的权限');
            }
            const ticket = crypto.randomBytes(32).toString('hex');
            nativeTickets.set(tokenKey(ticket), { sourceToken: token, expiresAt: now() + 30000 });
            return { ticket, expiresAt: now() + 30000 };
        },
        exchangeNativeTicket(ticket) {
            prune();
            const key = tokenKey(ticket);
            const grant = nativeTickets.get(key);
            nativeTickets.delete(key);
            if (!grant || now() >= grant.expiresAt) {
                throw authError(401, 'NATIVE_TICKET_INVALID', '大屏登录凭据已失效，请重新切换到实时大屏');
            }
            const source = getSession(grant.sourceToken);
            if (!source) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台会话已锁定，请重新登录');
            const permissions = permissionsForSession(source);
            if (!permissions.launch || !permissions.view) {
                throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有启动大屏的权限');
            }
            return issueSession('', source.userId);
        },
        async setup(password, key, previousToken) {
            validatePassword(password);
            return passwordOperation(key, async () => {
                if (config.password) throw authError(409, 'ADMIN_ALREADY_CONFIGURED', '后台密码已设置，请使用密码解锁');
                const credential = await hashPassword(password);
                saveConfig({ ...config, password: credential });
                return issueSession(previousToken);
            });
        },
        async login(password, key, previousToken, username = 'admin') {
            validatePassword(password);
            return passwordOperation(key, async () => {
                if (!config.password) throw authError(409, 'ADMIN_SETUP_REQUIRED', '请先由工程师设置后台密码');
                const generation = sessionGeneration;
                const normalizedName = String(username || 'admin').trim().toLowerCase();
                const user = normalizedName === 'admin' ? null
                    : config.users.find(item => item.username.toLowerCase() === normalizedName && item.enabled !== false);
                await verifyPassword(password, key, normalizedName === 'admin' ? config.password : user?.password || config.password);
                if (normalizedName !== 'admin' && !user) throw authError(401, 'ADMIN_PASSWORD_INVALID', '账号或密码不正确');
                if (generation !== sessionGeneration) {
                    throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已被锁定，请重新输入后台密码解锁');
                }
                return issueSession(previousToken, user?.id || 'owner');
            });
        },
        touch(token, csrfToken) {
            requireSession(token, csrfToken, { touch: true });
            return status(token);
        },
        logout(token, csrfToken) {
            requireSession(token, csrfToken);
            sessions.delete(tokenKey(token));
            return status('');
        },
        lock(token, csrfToken) {
            if (getSession(token)) {
                requireSession(token, csrfToken);
                // The owner can secure the entire console; other users only
                // sign themselves out and cannot revoke colleagues' sessions.
                if (principal(getSession(token)).role === 'owner') {
                    sessionGeneration += 1;
                    sessions.clear();
                } else sessions.delete(tokenKey(token));
            } else if (sessions.size > 0) {
                throw authError(401, 'ADMIN_AUTH_REQUIRED', '当前会话已失效，无法确认其他窗口已锁定；请重新解锁后再次锁定');
            }
            return status('');
        },
        updateSettings(token, csrfToken, idleTimeoutMinutes) {
            validateIdleMinutes(idleTimeoutMinutes);
            requireSession(token, csrfToken, { touch: true, permission: 'owner' });
            saveConfig({ ...config, idleTimeoutMinutes });
            return status(token);
        },
        async changePassword(token, csrfToken, currentPassword, newPassword, key) {
            validatePassword(currentPassword);
            validatePassword(newPassword);
            if (currentPassword === newPassword) throw authError(400, 'ADMIN_PASSWORD_UNCHANGED', '新密码不能与原密码相同');
            const session = requireSession(token, csrfToken);
            return passwordOperation(key, async () => {
                const user = session.userId === 'owner' ? null : config.users.find(item => item.id === session.userId);
                await verifyPassword(currentPassword, key, user?.password || config.password);
                const credential = await hashPassword(newPassword);
                // Locking in another window while hashing must cancel this change.
                requireSession(token, csrfToken);
                if (user) {
                    saveConfig({ ...config, users: config.users.map(item => item.id === user.id ? { ...item, password: credential } : item) });
                    for (const [sessionKey, active] of sessions) if (active.userId === user.id) sessions.delete(sessionKey);
                    return issueSession('', user.id);
                }
                saveConfig({ ...config, password: credential });
                sessionGeneration += 1;
                sessions.clear();
                return issueSession();
            });
        },
        listUsers(token, csrfToken) {
            requireSession(token, csrfToken, { permission: 'owner' });
            return config.users.map(({ password: _password, ...user }) => ({
                ...user,
                role: publicRole(user.role),
                permissions: permissionsForSession({ userId: user.id })
            }));
        },
        async createUser(token, csrfToken, input) {
            requireSession(token, csrfToken, { permission: 'owner' });
            const username = String(input?.username || '').trim().toLowerCase();
            const displayName = String(input?.displayName || username).trim();
            const role = String(input?.role || 'customer');
            if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username) || username === 'admin' || !displayName || displayName.length > 60 || !ASSIGNABLE_USER_ROLES.has(role)) {
                throw authError(400, 'ADMIN_USER_FORMAT', '账号需为 3–32 位字母、数字或下划线，且名称和角色必须有效');
            }
            validatePassword(input?.password);
            const permissions = normalizeUserPermissions(role, input?.permissions);
            if (config.users.length >= 64 || config.users.some(user => user.username.toLowerCase() === username)) {
                throw authError(409, 'ADMIN_USER_EXISTS', '账号已存在或达到 64 个账户上限');
            }
            const credential = await hashPassword(input.password);
            requireSession(token, csrfToken, { permission: 'owner' });
            if (config.users.some(user => user.username.toLowerCase() === username)) throw authError(409, 'ADMIN_USER_EXISTS', '账号已存在');
            const user = { id: crypto.randomBytes(12).toString('hex'), username, displayName, role, permissions, enabled: true, password: credential };
            saveConfig({ ...config, users: [...config.users, user] });
            const { password: _password, ...publicUser } = user;
            return publicUser;
        },
        async updateUser(token, csrfToken, id, input) {
            requireSession(token, csrfToken, { permission: 'owner' });
            const existing = config.users.find(user => user.id === id);
            if (!existing) throw authError(404, 'ADMIN_USER_NOT_FOUND', '账号不存在');
            const role = input?.role === undefined ? publicRole(existing.role) : String(input.role);
            const displayName = input?.displayName === undefined ? existing.displayName : String(input.displayName).trim();
            if (!ASSIGNABLE_USER_ROLES.has(role) || !displayName || displayName.length > 60 || typeof input?.enabled !== 'boolean') {
                throw authError(400, 'ADMIN_USER_FORMAT', '名称、角色或启用状态无效');
            }
            const permissions = input?.permissions === undefined
                ? input?.role === undefined
                    ? normalizeUserPermissions(role, existing.permissions)
                    : normalizeUserPermissions(role)
                : normalizeUserPermissions(role, input.permissions);
            const password = input?.password ? (validatePassword(input.password), await hashPassword(input.password)) : existing.password;
            requireSession(token, csrfToken, { permission: 'owner' });
            const updated = { ...existing, role, permissions, displayName, enabled: input.enabled, password };
            saveConfig({ ...config, users: config.users.map(user => user.id === id ? updated : user) });
            for (const [sessionKey, active] of sessions) if (active.userId === id) sessions.delete(sessionKey);
            const { password: _password, ...publicUser } = updated;
            return publicUser;
        },
        deleteUser(token, csrfToken, id) {
            requireSession(token, csrfToken, { permission: 'owner' });
            if (!config.users.some(user => user.id === id)) throw authError(404, 'ADMIN_USER_NOT_FOUND', '账号不存在');
            saveConfig({ ...config, users: config.users.filter(user => user.id !== id) });
            for (const [sessionKey, active] of sessions) if (active.userId === id) sessions.delete(sessionKey);
            return { success: true };
        }
    };
}

let instance;
function getAdminAuth() {
    instance ||= createAdminAuth();
    return instance;
}

module.exports = { authError, createAdminAuth, equalSecret, getAdminAuth, MAX_SESSION_MS };
