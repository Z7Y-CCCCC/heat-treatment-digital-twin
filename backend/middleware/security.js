const crypto = require('crypto');
const cors = require('cors');
const { assertLicenseForWrite, getLicenseStatus, isLicenseEnforced } = require('../services/license');
const { getAdminAuth } = require('../services/adminAuth');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CAST_READ_PATHS = [
    '/api/config', '/api/engine/status', '/api/health', '/api/models',
    '/api/platform/events', '/api/platform/metrics'
];

function isLoopbackAddress(address) {
    const value = String(address || '').trim().toLowerCase();
    return value === '::1'
        || /^(::ffff:)?127(?:\.\d{1,3}){3}$/.test(value)
        || value === 'localhost';
}

function splitList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function isLoopbackOrigin(origin) {
    try {
        const parsed = new URL(origin);
        return ['http:', 'https:'].includes(parsed.protocol)
            && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase());
    } catch (error) {
        return false;
    }
}

function createCorsMiddleware() {
    const configured = new Set(splitList(process.env.CORS_ALLOWED_ORIGINS));
    return cors((req, done) => done(null, {
        origin(origin, callback) {
            if (!origin || isLoopbackOrigin(origin) || configured.has(origin)) {
                callback(null, true);
                return;
            }
            callback(null, false);
        },
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-MCP-Token', 'X-Shutdown-Token', 'X-Admin-Request', 'X-CSRF-Token', 'X-Factory-ID'],
        maxAge: 600,
        credentials: !!req.get('origin') && isTrustedAdminOrigin(req)
    }));
}

function isTrustedAdminOrigin(req) {
    const origin = String(req.get('origin') || '');
    if (!origin) return req.get('sec-fetch-site') !== 'cross-site';
    if (splitList(process.env.CORS_ALLOWED_ORIGINS).includes(origin)) return true;
    if (!isLoopbackOrigin(origin)) return false;
    const parsed = new URL(origin);
    // Credentialed development requests use these exact ports, not every
    // arbitrary service on localhost. Other origins must be explicitly trusted.
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return [String(Number(process.env.PORT || 3001)), '5173', '4173', '3423'].includes(port);
}

function adminSessionCookieName() {
    return `dt_admin_session_${Number(process.env.PORT || 3001)}`;
}

function adminAccountCookieName(slotId) {
    if (!/^[a-f0-9]{24}$/.test(String(slotId || ''))) return '';
    return `${adminSessionCookieName()}_account_${slotId}`;
}

function adminActiveAccountCookieName() {
    return `${adminSessionCookieName()}_active`;
}

function requestCookies(req) {
    return new Map(String(req.get('cookie') || '').split(';').map(value => {
        const separator = value.indexOf('=');
        return separator < 0 ? null : [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
    }).filter(Boolean));
}

function activeAdminAccountSlot(req) {
    const active = requestCookies(req).get(adminActiveAccountCookieName());
    if (active === 'none') return 'none';
    return /^[a-f0-9]{24}$/.test(active || '') ? active : 'main';
}

function suppliedAdminSessionForSlot(req, slotId) {
    const cookies = requestCookies(req);
    if (slotId === 'main') return cookies.get(adminSessionCookieName()) || '';
    const name = adminAccountCookieName(slotId);
    return name ? cookies.get(name) || '' : '';
}

function suppliedAdminAccounts(req, service) {
    const cookies = requestCookies(req), base = adminSessionCookieName();
    const slots = [{ slotId: 'main', token: cookies.get(base) || '' }];
    const prefix = `${base}_account_`;
    for (const [name, token] of cookies) {
        if (!name.startsWith(prefix)) continue;
        const slotId = name.slice(prefix.length);
        if (/^[a-f0-9]{24}$/.test(slotId)) slots.push({ slotId, token });
    }
    return slots.filter(slot => slot.token).map(({ slotId, token }) => ({ slotId, ...service.status(token) }))
        .filter(account => account.authenticated);
}

function suppliedAdminSession(req) {
    const slotId = activeAdminAccountSlot(req);
    return slotId === 'none' ? '' : suppliedAdminSessionForSlot(req, slotId);
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:"
    ].join('; '));
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
    }
    next();
}

function safeTokenEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function suppliedAdminToken(req) {
    const direct = String(req.get('x-admin-token') || '');
    if (direct) return direct;
    const authorization = String(req.get('authorization') || '');
    return authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
}

function backupOperationPermission(apiPath, method) {
    if (apiPath === '/api/database/backups' || apiPath.startsWith('/api/database/backups/')) {
        const adminOnly = apiPath.endsWith('/config') || apiPath.endsWith('/restore') || method === 'DELETE';
        return adminOnly ? 'admin' : 'backup';
    }
    if (apiPath === '/api/site-backups' || apiPath.startsWith('/api/site-backups/')) {
        const adminOnly = apiPath.endsWith('/config') || apiPath.endsWith('/import');
        return adminOnly ? 'admin' : 'backup';
    }
    if (apiPath === '/api/data-sources/backups' || apiPath.startsWith('/api/data-sources/backups/')) {
        return /\/status$/.test(apiPath) || /\/run$/.test(apiPath) ? 'backup' : 'admin';
    }
    return '';
}

function permissionForApi(apiPath, method) {
    if (method === 'POST' && (apiPath === '/api/factories/activate'
        || /^\/api\/factories\/[^/]+\/activate$/.test(apiPath)
        || apiPath === '/api/native-preview/navigate'
        || /^\/api\/platform\/scenes\/[^/]+\/activate-latest-release$/.test(apiPath))) return 'launch';
    if (apiPath === '/api/system/cast' || apiPath.startsWith('/api/system/cast/')) return 'cast';
    const backupPermission = backupOperationPermission(apiPath, method);
    if (backupPermission) return backupPermission;
    if (apiPath === '/api/database' || apiPath.startsWith('/api/database/')) return 'admin';
    if (apiPath === '/api/platform' || apiPath.startsWith('/api/platform/')) return 'admin';
    if ((apiPath === '/api/system' || apiPath.startsWith('/api/system/'))
        && apiPath !== '/api/system/cast' && !apiPath.startsWith('/api/system/cast/')) return 'admin';
    if ((apiPath === '/api/data-sources' || apiPath.startsWith('/api/data-sources/'))
        && apiPath !== '/api/data-sources/runtime-values' && !apiPath.startsWith('/api/data-sources/runtime-values/')) return 'admin';
    if (!SAFE_METHODS.has(method)) return 'admin';
    return 'view';
}

function protectManagementWrites(req, res, next) {
    const apiPath = req.path.toLowerCase().replace(/\/+$/, '');
    const sensitiveRead = apiPath === '/api/database' || apiPath.startsWith('/api/database/')
        || apiPath === '/api/site-backups' || apiPath.startsWith('/api/site-backups/')
        || ((apiPath === '/api/data-sources' || apiPath.startsWith('/api/data-sources/'))
            && apiPath !== '/api/data-sources/runtime-values');
    const writing = !SAFE_METHODS.has(req.method);
    const displayNavigation = req.method === 'POST' && (/^\/api\/factories\/[^/]+\/activate$/.test(apiPath)
        || apiPath === '/api/native-preview/navigate'
        || /^\/api\/platform\/scenes\/[^/]+\/activate-latest-release$/.test(apiPath));
    const shutdown = req.method === 'POST' && apiPath === '/api/internal/shutdown';
    const licenseExempt = apiPath.startsWith('/api/license')
        || apiPath.startsWith('/api/admin-auth')
        || apiPath === '/api/health'
        || apiPath === '/api/version'
        || apiPath === '/api/release'
        || apiPath === '/api/release/verify'
        || shutdown;

    // In production mode an unlicensed installation may only reach the
    // license/status/recovery endpoints. This is what makes copying the
    // application folder to another computer insufficient for running it.
    // Development mode keeps the existing no-license workflow until the
    // desktop launcher explicitly enables enforcement.
    if (apiPath.startsWith('/api/') && isLicenseEnforced() && !licenseExempt) {
        const status = getLicenseStatus();
        if (!status.valid) {
            res.status(402).json({
                success: false,
                code: 'LICENSE_REQUIRED',
                error: `当前许可证不可用：${status.reason}`,
                license: { status: status.status, machineId: status.machineId }
            });
            return;
        }
    }

    // The LAN display has its own PIN-based, read-only authorization. Only
    // LanDisplayService can mark the request after validating that PIN; a
    // caller-controlled header cannot enter this path.
    const castRead = req.castAuthorized === true
        && SAFE_METHODS.has(req.method)
        && CAST_READ_PATHS.some(prefix => apiPath === prefix || apiPath.startsWith(`${prefix}/`));
    if (castRead) {
        next();
        return;
    }

    if (sensitiveRead) res.setHeader('Cache-Control', 'no-store');
    if (!apiPath.startsWith('/api/') || req.method === 'OPTIONS' || licenseExempt) {
        next();
        return;
    }

    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    const configuredToken = String(process.env.ADMIN_API_TOKEN || '');
    const tokenAuthorized = configuredToken && safeTokenEqual(suppliedAdminToken(req), configuredToken);
    const mcpToken = String(process.env.MCP_API_TOKEN || '');
    const mcpAuthorized = mcpToken && (loopback || apiPath === '/api/mcp')
        && safeTokenEqual(req.get('x-mcp-token') || suppliedAdminToken(req), mcpToken);
    if (!loopback && !tokenAuthorized && !mcpAuthorized) {
        res.status(403).json({
            success: false,
            error: '现场服务仅允许在现场电脑本机登录和访问；远程管理需配置 ADMIN_API_TOKEN'
        });
        return;
    }

    // Runtime navigation can only choose a view / an already-published scene.
    // Layout preview, uploads, configuration and release editing stay protected.
    if (displayNavigation && !isTrustedAdminOrigin(req)) {
        res.status(403).json({ success: false, code: 'ADMIN_ORIGIN_INVALID', error: '拒绝跨站大屏导航请求' });
        return;
    }
    if (!tokenAuthorized && !mcpAuthorized && !shutdown) {
        try {
            if (writing && !isTrustedAdminOrigin(req)) {
                res.status(403).json({ success: false, code: 'ADMIN_ORIGIN_INVALID', error: '拒绝跨站后台修改请求' });
                return;
            }
            // Polling and background previews must never keep an idle engineer
            // session alive. Only the explicit user-activity endpoint does that.
            getAdminAuth().requireSession(suppliedAdminSession(req), req.get('x-csrf-token'), {
                checkCsrf: writing, permission: permissionForApi(apiPath, req.method)
            });
        } catch (error) {
            res.status(error.statusCode || 503).json({ success: false, code: error.code || 'ADMIN_AUTH_ERROR', error: error.message });
            return;
        }
    }

    // 安装/替换许可证和安全退出必须能在许可证失效时执行，避免现场被锁死。
    if (writing && !licenseExempt) {
        try {
            assertLicenseForWrite();
        } catch (error) {
            res.status(402).json({ success: false, code: error.code || 'LICENSE_REQUIRED', error: error.message });
            return;
        }
    }
    next();
}

function createOperationRateLimiter(options = {}) {
    const windowMs = Math.max(1000, Number(options.windowMs || 10 * 60 * 1000));
    const limit = Math.max(1, Number(options.limit || 20));
    const entries = new Map();

    return (req, res, next) => {
        const now = Date.now();
        const key = `${req.socket.remoteAddress || 'unknown'}:${options.name || req.path}`;
        const current = entries.get(key);
        if (!current || now >= current.resetAt) {
            entries.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }
        current.count += 1;
        if (current.count <= limit) {
            next();
            return;
        }
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
        res.status(429).json({ success: false, error: '操作过于频繁，请稍后再试' });
    };
}

module.exports = {
    activeAdminAccountSlot,
    adminAccountCookieName,
    adminActiveAccountCookieName,
    adminSessionCookieName,
    createCorsMiddleware,
    createOperationRateLimiter,
    isLoopbackAddress,
    isTrustedAdminOrigin,
    protectManagementWrites,
    securityHeaders,
    suppliedAdminAccounts,
    suppliedAdminSession,
    suppliedAdminSessionForSlot
};
