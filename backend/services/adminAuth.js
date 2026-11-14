const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_IDLE_MINUTES = 30;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const DISPLAY_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const USER_ROLES = new Set(['customer', 'viewer', 'editor']);
const ASSIGNABLE_USER_ROLES = new Set(['customer', 'viewer']);
const DELEGABLE_PERMISSIONS = ['view', 'launch', 'cast', 'backup'];
const { normalizePagePermissions, normalizeStoredPagePermissions, canAccessAdmin, allowsRequirement } = require('../../shared/pagePermissions.cjs');
const { getAdminPageCatalog } = require('../../shared/adminPages.mjs');
const { defaultAccountPagePermissions } = require('../../shared/accountTemplates.mjs');
const { isValidUsername, normalizeUsername, isValidPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = require('../../shared/accountPolicy.mjs');

function userPagePermissions(value) {
    try { return normalizePagePermissions(value); }
    catch { throw authError(400, 'ADMIN_PAGE_PERMISSIONS_FORMAT', '页面权限无效；操作权限需同时勾选查看，用户管理和后台安全不可委派'); }
}

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
    if (!isValidPassword(password)) {
        throw authError(400, 'ADMIN_PASSWORD_FORMAT', `密码需为 ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符，不能全为空格`);
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
    const sessionsFilename = path.join(path.resolve(dataDir), 'admin-sessions.json');
    const now = options.now || Date.now;
    const maxSessionMs = options.maxSessionMs || MAX_SESSION_MS;
    // Admin privileges expire on inactivity. An already-authorized display may
    // survive a local restart, but not logout, revocation or the 30-day deadline.
    const sessions = new Map();
    const attempts = new Map();
    const nativeTickets = new Map();
    // Ephemeral reconnect proofs: never persisted, exposed or logged. Only the
    // source session may observe the new child connection for its own ticket.
    const nativeConfirmations = new Map();
    let passwordOperationBusy = false;
    let sessionGeneration = 0;
    let config = { version: 1, idleTimeoutMinutes: DEFAULT_IDLE_MINUTES, password: null, users: [] };
    let sessionsDirty = false;

    if (fs.existsSync(filename)) {
        try {
            const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (stored.version !== 1 || !/^[a-f0-9]{32}$/.test(stored.password?.salt || '')
                || !/^[a-f0-9]{128}$/.test(stored.password?.hash || '')) throw new Error('Invalid credential');
            validateIdleMinutes(stored.idleTimeoutMinutes);
            if (stored.users !== undefined && (!Array.isArray(stored.users) || stored.users.length > 64
                || stored.users.some(user => !isValidUsername(user.username)
                    || !USER_ROLES.has(user.role) || !/^[a-f0-9]{32}$/.test(user.password?.salt || '')
                    || !/^[a-f0-9]{128}$/.test(user.password?.hash || '')
                    || !storedUserPermissionsAreValid(user.permissions)
                    || !normalizeStoredPagePermissions(user.pagePermissions)))) throw new Error('Invalid users');
            config = { ...stored, users: (stored.users || []).map(user => ({ ...user,
                pagePermissions: normalizeStoredPagePermissions(user.pagePermissions) })) };
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

    function sessionSignature(rows) {
        const credentials = config.users.map(user => ({ id: user.id, enabled: user.enabled !== false, hash: user.password.hash }));
        return crypto.createHmac('sha256', config.password?.hash || '')
            .update(JSON.stringify({ credentials, rows })).digest('hex');
    }

    function saveSessions() {
        if (!sessionsDirty) return;
        // Only hashes of browser bearer tokens are stored. Native handoffs and
        // single-use tickets are process-local and cannot be replayed on restart.
        const rows = [...sessions].filter(([, session]) => !session.parentSessionKey);
        const temporary = `${sessionsFilename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        try {
            fs.mkdirSync(path.dirname(sessionsFilename), { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, rows, signature: sessionSignature(rows) }),
                { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            // Windows antivirus/OneDrive may briefly hold the previous file.
            // Retry replacement, never unlink it and lose atomic revocation.
            for (let attempt = 0; ; attempt += 1) {
                try { fs.renameSync(temporary, sessionsFilename); break; }
                catch (error) {
                    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
                }
            }
            sessionsDirty = false;
        } catch {
            try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
            throw authError(503, 'ADMIN_SESSION_STORAGE_UNAVAILABLE', '无法保存本机登录状态，请检查应用数据目录的写入权限');
        }
    }

    if (config.password && fs.existsSync(sessionsFilename)) {
        try {
            if (fs.statSync(sessionsFilename).size > 128 * 1024) throw new Error('Oversized session store');
            const stored = JSON.parse(fs.readFileSync(sessionsFilename, 'utf8'));
            if (stored.version !== 1 || !Array.isArray(stored.rows) || stored.rows.length > 64
                || !equalSecret(stored.signature, sessionSignature(stored.rows))) throw new Error('Invalid session store');
            for (const [key, session] of stored.rows) {
                if (!/^[a-f0-9]{64}$/.test(key) || !session || session.parentSessionKey
                    || !/^[a-f0-9]{64}$/.test(session.csrfToken)
                    || ![session.issuedAt, session.lastActivityAt, session.absoluteExpiresAt, session.displayExpiresAt].every(Number.isFinite)
                    || session.issuedAt > now() || session.lastActivityAt < session.issuedAt || session.lastActivityAt > now()
                    || session.absoluteExpiresAt > session.issuedAt + maxSessionMs
                    || session.displayExpiresAt !== session.issuedAt + DISPLAY_SESSION_MS
                    || (session.userId !== 'owner' && !config.users.some(user => user.id === session.userId && user.enabled !== false))) {
                    throw new Error('Invalid stored session');
                }
                if (now() < session.displayExpiresAt) sessions.set(key, { ...session,
                    adminLocked: session.adminLocked === true || now() >= sessionExpiry(session) });
            }
        } catch {
            // A damaged/copied/credential-mismatched store never unlocks access.
            sessions.clear();
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

    function adminActive(session) {
        return !!session && !session.adminLocked && now() < sessionExpiry(session);
    }

    function prune() {
        const time = now();
        for (const [key, session] of sessions) {
            if (time >= sessionExpiry(session) && !session.adminLocked) { session.adminLocked = true; sessionsDirty = true; }
            if (time >= session.displayExpiresAt || (session.parentSessionKey && !sessions.has(session.parentSessionKey))) {
                sessions.delete(key); sessionsDirty = true;
            }
        }
        for (const [key, attempt] of attempts) {
            if (time >= attempt.resetAt) attempts.delete(key);
        }
        for (const [key, ticket] of nativeTickets) {
            if (time >= ticket.expiresAt) nativeTickets.delete(key);
        }
        for (const [key, confirmation] of nativeConfirmations) {
            if (time >= confirmation.expiresAt || !sessions.has(confirmation.sourceSessionKey)
                || confirmation.childSessionKey && !sessions.has(confirmation.childSessionKey)) {
                // Keep an unexchanged grant until its original 30-second timer
                // solely so exchange reports revoked source auth accurately.
                // getSession/active checks still make it unusable immediately.
                if (time >= confirmation.expiresAt || !nativeTickets.has(key)) clearTimeout(confirmation.timer);
                nativeConfirmations.delete(key);
                if (time >= confirmation.expiresAt) nativeTickets.delete(key);
            }
        }
        saveSessions();
    }

    function getSession(token) {
        prune();
        const key = tokenKey(token);
        const session = sessions.get(key);
        if (!session) return null;
        if (session.parentSessionKey && !sessions.has(session.parentSessionKey)) {
            sessions.delete(key);
            sessionsDirty = true;
            saveSessions();
            return null;
        }
        if (session.userId !== 'owner' && !config.users.some(user => user.id === session.userId && user.enabled !== false)) {
            sessions.delete(key);
            sessionsDirty = true;
            saveSessions();
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
        const authenticated = adminActive(session);
        const permissions = permissionsForSession(session);
        const pagePermissions = normalizePagePermissions(session?.userId === 'owner' ? undefined
            : config.users.find(user => user.id === session?.userId)?.pagePermissions,
            { owner: authenticated && session?.userId === 'owner' });
        const activePagePermissions = authenticated ? pagePermissions : normalizePagePermissions();
        return {
            success: true,
            configured: !!config.password,
            authenticated,
            displayAuthenticated: !!session,
            pagePermissions: activePagePermissions,
            ...(authenticated ? { pageCatalog: getAdminPageCatalog() } : {}),
            canAccessAdmin: authenticated && canAccessAdmin(activePagePermissions),
            ...settings(),
            ...(session ? {
                user: principal(session),
                permissions: { ...permissions, edit: authenticated && permissions.edit, manageUsers: authenticated && permissions.manageUsers },
                csrfToken: session.csrfToken,
                expiresAt: sessionExpiry(session),
                absoluteExpiresAt: session.absoluteExpiresAt
            } : {})
        };
    }

    function requireSession(token, csrfToken, { touch = false, checkCsrf = true, permission = 'view' } = {}) {
        const session = getSession(token);
        if (!session) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已锁定，请输入后台密码解锁');
        if (!adminActive(session) && touch) {
            throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已锁定，请输入后台密码解锁');
        }
        if (checkCsrf && !equalSecret(csrfToken, session.csrfToken)) {
            throw authError(403, 'ADMIN_CSRF_INVALID', '安全校验已失效，请刷新页面后重试');
        }
        const role = principal(session)?.role;
        const permissions = permissionsForSession(session);
        const active = adminActive(session);
        const pagePermissions = normalizePagePermissions(session.userId === 'owner' ? undefined
            : config.users.find(user => user.id === session.userId)?.pagePermissions, { owner: session.userId === 'owner' });
        if (!allowsRequirement(permission, { owner: role === 'owner', active, permissions, pagePermissions })) {
            if (!active) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已锁定，请输入后台密码解锁');
            throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有执行此页面操作的权限');
        }
        if (touch) { session.lastActivityAt = now(); sessionsDirty = true; saveSessions(); }
        return { ...session, role, userId: session.userId };
    }

    function issueSession(previousToken, userId = 'owner', parentToken = '') {
        prune();
        const previousKey = tokenKey(previousToken);
        const previous = sessions.get(previousKey);
        sessions.delete(previousKey);
        while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('hex');
        const key = tokenKey(token);
        const issuedAt = now();
        sessions.set(key, {
            userId,
            ...(parentToken ? { parentSessionKey: tokenKey(parentToken) } : {}),
            csrfToken: crypto.randomBytes(32).toString('hex'),
            issuedAt,
            lastActivityAt: issuedAt,
            absoluteExpiresAt: issuedAt + maxSessionMs,
            displayExpiresAt: issuedAt + DISPLAY_SESSION_MS
        });
        // Unlocking the same account must not interrupt an already-running
        // native display that was handed off by the previous admin token.
        for (const [childKey, child] of sessions) {
            if (child.parentSessionKey !== previousKey) continue;
            if (previous?.userId === userId) child.parentSessionKey = key;
            else sessions.delete(childKey);
        }
        sessionsDirty = true;
        saveSessions();
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
            const session = requireSession(token, csrfToken, { permission: { all: ['session', 'launch', 'view'] } });
            if (!permissionsForSession(session).view) {
                throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有查看大屏的权限');
            }
            if (nativeConfirmations.size >= 64 || nativeTickets.size >= 64) throw authError(429, 'NATIVE_TICKET_LIMIT', '大屏连接操作过于频繁，请稍后再试', 30);
            const ticket = crypto.randomBytes(32).toString('hex');
            const key = tokenKey(ticket), expiresAt = now() + 30000;
            const confirmation = { sourceSessionKey: tokenKey(token), childSessionKey: '', expiresAt,
                timer: setTimeout(() => { nativeConfirmations.delete(key); nativeTickets.delete(key); }, 30000) };
            confirmation.timer.unref?.();
            nativeConfirmations.set(key, confirmation);
            nativeTickets.set(key, { sourceToken: token, sourceSessionKey: tokenKey(token), expiresAt });
            return { ticket, expiresAt };
        },
        exchangeNativeTicket(ticket, previousToken = '') {
            prune();
            const key = tokenKey(ticket);
            const grant = nativeTickets.get(key);
            nativeTickets.delete(key);
            if (!grant || now() >= grant.expiresAt) {
                throw authError(401, 'NATIVE_TICKET_INVALID', '大屏登录凭据已失效，请重新切换到实时大屏');
            }
            const source = getSession(grant.sourceToken);
            if (!source || !adminActive(source)) throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台会话已锁定，请重新登录');
            const permissions = permissionsForSession(source);
            if (!permissions.launch || !permissions.view) {
                throw authError(403, 'ADMIN_PERMISSION_DENIED', '当前账户没有启动大屏的权限');
            }
            const previous = sessions.get(tokenKey(previousToken));
            const result = issueSession(previous?.parentSessionKey ? previousToken : '', source.userId, grant.sourceToken);
            const confirmation = nativeConfirmations.get(key);
            if (confirmation) confirmation.childSessionKey = tokenKey(result.token);
            return result;
        },
        confirmNativeTicket(token, csrfToken, ticket, connectionProbe = () => ({})) {
            requireSession(token, csrfToken, { permission: { all: ['session', 'launch', 'view'] } });
            const key = tokenKey(ticket), confirmation = nativeConfirmations.get(key);
            if (!confirmation || !equalSecret(confirmation.sourceSessionKey, tokenKey(token)) || now() >= confirmation.expiresAt) {
                throw authError(401, 'NATIVE_CONFIRM_INVALID', '本次大屏连接确认已失效，请重新连接');
            }
            const child = confirmation.childSessionKey && sessions.get(confirmation.childSessionKey);
            const exchanged = Boolean(child && child.parentSessionKey === confirmation.sourceSessionKey);
            const connection = exchanged ? connectionProbe(confirmation.childSessionKey, now()) || {} : {};
            return { success: true, exchanged, connected: exchanged && connection.connected === true,
                sceneReady: exchanged && connection.connected === true && connection.sceneReady === true, observedAt: now() };
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
                const normalizedName = normalizeUsername(username || 'admin');
                const user = normalizedName === 'admin' ? null
                    : config.users.find(item => normalizeUsername(item.username) === normalizedName && item.enabled !== false);
                await verifyPassword(password, key, normalizedName === 'admin' ? config.password : user?.password || config.password);
                if (normalizedName !== 'admin' && !user) throw authError(401, 'ADMIN_PASSWORD_INVALID', '账号或密码不正确');
                if (generation !== sessionGeneration) {
                    throw authError(401, 'ADMIN_AUTH_REQUIRED', '后台已被锁定，请重新输入后台密码解锁');
                }
                return issueSession(previousToken, user?.id || 'owner');
            });
        },
        touch(token, csrfToken) {
            requireSession(token, csrfToken, { touch: true, permission: 'session' });
            return status(token);
        },
        logout(token, csrfToken) {
            const active = getSession(token);
            if (!active) throw authError(401, 'ADMIN_AUTH_REQUIRED', '账户已退出，请重新登录');
            if (!equalSecret(csrfToken, active.csrfToken)) throw authError(403, 'ADMIN_CSRF_INVALID', '安全校验已失效，请刷新页面后重试');
            const key = tokenKey(token);
            sessions.delete(key);
            for (const [childKey, session] of sessions) if (session.parentSessionKey === key) sessions.delete(childKey);
            sessionsDirty = true;
            saveSessions();
            return status('');
        },
        lock(token, csrfToken) {
            const session = getSession(token);
            if (session && adminActive(session)) {
                requireSession(token, csrfToken, { permission: 'session' });
                // The owner can secure the entire console; other users only
                // lock their own admin access. Displays stay authorized.
                if (principal(session).role === 'owner') {
                    sessionGeneration += 1;
                    for (const active of sessions.values()) active.adminLocked = true;
                } else session.adminLocked = true;
                nativeTickets.clear();
                for (const confirmation of nativeConfirmations.values()) clearTimeout(confirmation.timer);
                nativeConfirmations.clear();
                sessionsDirty = true;
                saveSessions();
            } else if (sessions.size > 0 && [...sessions.values()].some(adminActive)) {
                throw authError(401, 'ADMIN_AUTH_REQUIRED', '当前会话已失效，无法确认其他窗口已锁定；请重新解锁后再次锁定');
            }
            return status(token);
        },
        updateSettings(token, csrfToken, idleTimeoutMinutes) {
            validateIdleMinutes(idleTimeoutMinutes);
            requireSession(token, csrfToken, { touch: true, permission: 'owner' });
            saveConfig({ ...config, idleTimeoutMinutes });
            sessionsDirty = true;
            saveSessions();
            return status(token);
        },
        async changePassword(token, csrfToken, currentPassword, newPassword, key) {
            validatePassword(currentPassword);
            validatePassword(newPassword);
            if (currentPassword === newPassword) throw authError(400, 'ADMIN_PASSWORD_UNCHANGED', '新密码不能与原密码相同');
            const session = requireSession(token, csrfToken, { permission: 'session' });
            return passwordOperation(key, async () => {
                const user = session.userId === 'owner' ? null : config.users.find(item => item.id === session.userId);
                await verifyPassword(currentPassword, key, user?.password || config.password);
                const credential = await hashPassword(newPassword);
                // Locking in another window while hashing must cancel this change.
                requireSession(token, csrfToken, { permission: 'session' });
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
                pagePermissions: userPagePermissions(user.pagePermissions),
                permissions: permissionsForSession({ userId: user.id })
            }));
        },
        async createUser(token, csrfToken, input) {
            requireSession(token, csrfToken, { permission: 'owner' });
            const username = normalizeUsername(input?.username);
            const displayName = String(input?.displayName || username).trim();
            const role = String(input?.role || 'customer');
            if (!isValidUsername(username) || username === 'admin' || !displayName || displayName.length > 60 || !ASSIGNABLE_USER_ROLES.has(role)) {
                throw authError(400, 'ADMIN_USER_FORMAT', '账号需为 2–32 位中文、字母、数字、下划线或短横线，以中文或字母开头；名称和角色须有效');
            }
            validatePassword(input?.password);
            const permissions = normalizeUserPermissions(role, input?.permissions);
            const pagePermissions = input?.pagePermissions === undefined
                ? defaultAccountPagePermissions(role) : userPagePermissions(input.pagePermissions);
            if (config.users.length >= 64 || config.users.some(user => normalizeUsername(user.username) === username)) {
                throw authError(409, 'ADMIN_USER_EXISTS', '账号已存在或达到 64 个账户上限');
            }
            const credential = await hashPassword(input.password);
            requireSession(token, csrfToken, { permission: 'owner' });
            if (config.users.some(user => normalizeUsername(user.username) === username)) throw authError(409, 'ADMIN_USER_EXISTS', '账号已存在');
            const user = { id: crypto.randomBytes(12).toString('hex'), username, displayName, role, permissions, pagePermissions, enabled: true, password: credential };
            saveConfig({ ...config, users: [...config.users, user] });
            sessionsDirty = true;
            saveSessions();
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
            const pagePermissions = userPagePermissions(input?.pagePermissions === undefined ? existing.pagePermissions : input.pagePermissions);
            requireSession(token, csrfToken, { permission: 'owner' });
            const updated = { ...existing, role, permissions, pagePermissions, displayName, enabled: input.enabled, password };
            saveConfig({ ...config, users: config.users.map(user => user.id === id ? updated : user) });
            // Legacy policy: every account update revokes that account's old
            // browser and native sessions. Require a fresh login after changes.
            for (const [sessionKey, active] of sessions) if (active.userId === id) sessions.delete(sessionKey);
            sessionsDirty = true;
            saveSessions();
            const { password: _password, ...publicUser } = updated;
            return publicUser;
        },
        deleteUser(token, csrfToken, id) {
            requireSession(token, csrfToken, { permission: 'owner' });
            if (!config.users.some(user => user.id === id)) throw authError(404, 'ADMIN_USER_NOT_FOUND', '账号不存在');
            saveConfig({ ...config, users: config.users.filter(user => user.id !== id) });
            for (const [sessionKey, active] of sessions) if (active.userId === id) sessions.delete(sessionKey);
            sessionsDirty = true;
            saveSessions();
            return { success: true };
        }
    };
}

let instance;
function getAdminAuth() {
    instance ||= createAdminAuth();
    return instance;
}

module.exports = { authError, createAdminAuth, equalSecret, getAdminAuth, MAX_SESSION_MS, DISPLAY_SESSION_MS };
