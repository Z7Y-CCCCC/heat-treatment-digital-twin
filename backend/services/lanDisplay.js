const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { getDb } = require('../db/database');

const ACCESS_COOKIE = 'heat_treatment_cast_access';
const DEFAULT_PORT = 8787;
const DEFAULT_PIN = '000000';
const PUBLIC_API_PREFIXES = [
    '/api/config',
    '/api/engine/status',
    '/api/health',
    '/api/models',
    '/api/platform/events',
    '/api/platform/metrics'
];

function randomPin() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizePin(value) {
    const pin = String(value || '').replace(/\D/g, '').slice(0, 6);
    return /^\d{6}$/.test(pin) ? pin : randomPin();
}

function normalizePort(value, fallback = DEFAULT_PORT) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return fallback;
    return port;
}

function parseCookies(header) {
    const cookies = {};
    String(header || '').split(';').forEach(pair => {
        const index = pair.indexOf('=');
        if (index <= 0) return;
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        try { cookies[key] = decodeURIComponent(value); } catch (error) { cookies[key] = value; }
    });
    return cookies;
}

function secureTokenEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function getIpv4Addresses() {
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (/^169\.254\./.test(entry.address)) continue;
            if (!addresses.includes(entry.address)) addresses.push(entry.address);
        }
    }
    return addresses.sort((a, b) => {
        const privateScore = value => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value) ? 0 : 1);
        return privateScore(a) - privateScore(b) || a.localeCompare(b);
    });
}

function pairingPage() {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>热处理数字孪生大屏 - 投屏连接</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101820;color:#f2f5f4;font-family:"Microsoft YaHei",sans-serif}
main{width:min(520px,calc(100vw - 40px));padding:32px;background:#17232c;border:1px solid #43515a;box-shadow:0 18px 60px #0008}
h1{margin:0 0 12px;font-size:24px}p{color:#b7c4c6;line-height:1.7}label{display:block;margin:22px 0 8px;color:#dbe5e3}input{box-sizing:border-box;width:100%;padding:14px;font-size:24px;letter-spacing:8px;text-align:center;background:#0d151b;color:#fff;border:1px solid #66757b}button{margin-top:18px;width:100%;padding:13px;border:0;background:#eeb35c;color:#1b2022;font-size:16px;font-weight:700;cursor:pointer}small{display:block;margin-top:16px;color:#8d9a9d}
</style></head><body><main><h1>连接远程大屏</h1><p>请向现场工程师索取 6 位投屏码，输入后点击“进入大屏”。连接成功后，本浏览器会记住授权。</p><form id="form"><label for="pin">投屏码</label><input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required><button>进入大屏</button></form><small>请确认电视和现场电脑处于同一个局域网。</small></main><script>document.getElementById('form').addEventListener('submit',function(e){e.preventDefault();var p=document.getElementById('pin').value.replace(/\\D/g,'');if(!/^\\d{6}$/.test(p)){alert('请输入 6 位数字投屏码');return}location.href='/?cast_token='+encodeURIComponent(p)+'&cast=1'})</script></body></html>`;
}

function parseDeviceName(userAgent, remoteAddress) {
    const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
    const ua = String(userAgent || '');

    let deviceType = '未知设备';
    if (/SmartTV|MiTV|Tizen|WebOS|Android TV|HUAWEI|AppleTV|Hisense|Skyworth|TCL|Sony/i.test(ua)) {
        if (/MiTV|Xiaomi/i.test(ua)) deviceType = '小米电视';
        else if (/Huawei|Hisi/i.test(ua)) deviceType = '华为智慧屏';
        else if (/Tizen|Samsung/i.test(ua)) deviceType = '三星电视';
        else if (/WebOS|LG/i.test(ua)) deviceType = 'LG 智能电视';
        else if (/Hisense/i.test(ua)) deviceType = '海信电视';
        else if (/Skyworth/i.test(ua)) deviceType = '创维电视';
        else if (/TCL/i.test(ua)) deviceType = 'TCL 电视';
        else if (/Sony/i.test(ua)) deviceType = '索尼电视';
        else deviceType = '智能电视/电视盒';
    } else if (/iPad/i.test(ua)) {
        deviceType = 'iPad 平板';
    } else if (/Android/i.test(ua)) {
        deviceType = 'Android 移动设备';
    } else if (/iPhone/i.test(ua)) {
        deviceType = 'iPhone 手机';
    } else if (/Windows/i.test(ua)) {
        deviceType = 'Windows PC';
    } else if (/Macintosh|Mac OS/i.test(ua)) {
        deviceType = 'Mac 电脑';
    } else if (/Linux/i.test(ua)) {
        deviceType = 'Linux 设备';
    }

    return ip ? `${deviceType} (${ip})` : deviceType;
}

class LanDisplayService {
    constructor({ app, wsServer, primaryPort }) {
        this.app = app;
        this.wsServer = wsServer;
        this.primaryPort = Number(primaryPort || 0);
        this.server = null;
        this.wss = null;
        this.port = DEFAULT_PORT;
        this.pin = DEFAULT_PIN;
        this.enabled = false;
        this.running = false;
        this.error = '';
        this.clientCount = 0;
        this.connectedClientsMap = new Map();
    }

    async loadFromSettings() {
        const db = await getDb();
        const rows = await db.all(
            "SELECT `key`, `value` FROM `settings` WHERE `key` IN ('lan_display_enabled', 'lan_display_port', 'lan_display_pin')"
        );
        const settings = {};
        rows.forEach(row => { settings[row.key] = row.value; });
        const pin = normalizePin(settings.lan_display_pin);
        if (settings.lan_display_pin !== pin) {
            await db.upsert('settings', { key: 'lan_display_pin', value: pin }, 'key');
        }
        this.pin = pin;
        this.port = normalizePort(settings.lan_display_port, DEFAULT_PORT);
        this.enabled = ['1', 'true', 'yes', 'on'].includes(String(settings.lan_display_enabled || '').toLowerCase());
        if (this.enabled) await this.apply({ enabled: true, port: this.port, pin: this.pin });
        return this.status();
    }

    async apply({ enabled, port, pin } = {}) {
        const previousPin = this.pin;
        const previousPort = this.port;
        const nextEnabled = Boolean(enabled);
        const nextPort = normalizePort(port, this.port || DEFAULT_PORT);
        const nextPin = normalizePin(pin || this.pin);
        const pinChanged = previousPin !== nextPin;
        this.pin = nextPin;
        this.port = nextPort;
        this.error = '';

        if (!nextEnabled) {
            this.enabled = false;
            await this.stop();
            return this.status();
        }
        if (nextPort === this.primaryPort) {
            this.error = `投屏端口不能与本机服务端口 ${this.primaryPort} 相同`;
            this.enabled = false;
            await this.stop();
            return this.status();
        }
        if (this.running && previousPort === nextPort && !pinChanged) {
            this.enabled = true;
            return this.status();
        }

        await this.stop();
        this.enabled = true;
        this.port = nextPort;
        let server = null;
        let wss = null;
        try {
            server = http.createServer((req, res) => this.handleRequest(req, res));
            wss = this.wsServer.attach(server, {
                verifyClient: info => this.verifyWebSocket(info?.req),
                onConnection: (ws, req) => {
                    const ip = req?.socket?.remoteAddress || '';
                    const ua = req?.headers?.['user-agent'] || '';
                    const name = parseDeviceName(ua, ip);
                    const clientId = `${ip}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    ws._lanClientId = clientId;
                    this.connectedClientsMap.set(clientId, {
                        id: clientId,
                        name,
                        ip: String(ip).replace(/^::ffff:/, ''),
                        connectedAt: new Date().toISOString()
                    });
                    this.clientCount = this.connectedClientsMap.size;
                },
                onClose: (ws) => {
                    if (ws._lanClientId) {
                        this.connectedClientsMap.delete(ws._lanClientId);
                    }
                    this.clientCount = this.connectedClientsMap.size;
                }
            });
            await new Promise((resolve, reject) => {
                const onError = error => { server.off('listening', onListening); reject(error); };
                const onListening = () => { server.off('error', onError); resolve(); };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.port, '0.0.0.0');
            });
            this.server = server;
            this.wss = wss;
            this.running = true;
            console.log(`[投屏] 局域网远程大屏已开启: ${this.getPairingUrls().join(', ')}`);
        } catch (error) {
            this.error = `投屏服务启动失败：${error.message}`;
            this.running = false;
            this.enabled = false;
            try { this.wsServer.detach(wss); } catch (detachError) { /* ignore */ }
            try { server?.close(); } catch (closeError) { /* ignore */ }
            this.wss = null;
            this.server = null;
        }
        return this.status();
    }

    async stop() {
        const server = this.server;
        const wss = this.wss;
        this.server = null;
        this.wss = null;
        this.running = false;
        this.clientCount = 0;
        this.connectedClientsMap.clear();
        if (wss) {
            for (const client of wss.clients || []) {
                try { client.terminate(); } catch (error) { /* ignore */ }
            }
            this.wsServer.detach(wss);
        }
        if (!server) return;
        await new Promise(resolve => {
            try { server.close(() => resolve()); } catch (error) { resolve(); }
        });
    }

    verifyWebSocket(req) {
        if (!this.running) return false;
        const parsed = new URL(req?.url || '/', 'http://lan-display.local');
        const queryToken = parsed.searchParams.get('cast_token');
        const cookieToken = parseCookies(req?.headers?.cookie)[ACCESS_COOKIE];
        return secureTokenEqual(queryToken, this.pin) || secureTokenEqual(cookieToken, this.pin);
    }

    isValidDisplaySocket(req) {
        return this.verifyWebSocket(req);
    }

    isAllowedPath(pathname) {
        if (pathname === '/ws') return true;
        if (pathname === '/admin' || pathname.startsWith('/admin/')) return false;
        if (pathname.startsWith('/api/')) return PUBLIC_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
        return pathname === '/' || pathname === '/index.html'
            || pathname.startsWith('/assets/')
            || pathname.startsWith('/uploads/')
            || pathname === '/favicon.ico';
    }

    accessToken(req, parsed) {
        const queryToken = parsed.searchParams.get('cast_token');
        const cookieToken = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
        return {
            valid: secureTokenEqual(queryToken, this.pin) || secureTokenEqual(cookieToken, this.pin),
            fromQuery: secureTokenEqual(queryToken, this.pin)
        };
    }

    handleRequest(req, res) {
        const parsed = new URL(req.url || '/', 'http://lan-display.local');
        const pathname = parsed.pathname || '/';
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET, HEAD, OPTIONS');
            res.end('投屏端只允许读取大屏内容');
            return;
        }
        if (!this.isAllowedPath(pathname)) {
            res.statusCode = 403;
            res.end('该局域网投屏端只提供只读大屏');
            return;
        }

        const access = this.accessToken(req, parsed);
        if (!access.valid) {
            if (pathname === '/' || pathname === '/index.html') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(pairingPage());
                return;
            }
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: '需要投屏码授权' }));
            return;
        }

        if (access.fromQuery) {
            res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=${encodeURIComponent(this.pin)}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly`);
            parsed.searchParams.delete('cast_token');
            if (pathname === '/' || pathname === '/index.html') {
                parsed.searchParams.set('cast', '1');
                res.statusCode = 302;
                res.setHeader('Location', `${parsed.pathname || '/'}${parsed.search ? `?${parsed.searchParams.toString()}` : ''}`);
                res.end();
                return;
            }
        }

        req.castAuthorized = true;
        req.url = `${parsed.pathname || '/'}${parsed.search || ''}`;
        this.app(req, res);
    }

    getPairingUrls() {
        const addresses = getIpv4Addresses();
        const hosts = addresses.length ? addresses : ['127.0.0.1'];
        return hosts.map(address => `http://${address}:${this.port}/?cast_token=${encodeURIComponent(this.pin)}&cast=1`);
    }

    status() {
        const urls = this.running ? this.getPairingUrls().map(url => {
            try {
                const parsed = new URL(url);
                parsed.searchParams.delete('cast_token');
                return parsed.toString();
            } catch (error) {
                return url;
            }
        }) : [];
        const clientDevices = Array.from(this.connectedClientsMap.values());
        const clientList = clientDevices.map(c => c.name);
        return {
            enabled: this.enabled,
            running: this.running,
            port: this.port,
            pin: this.pin,
            urls,
            pairingUrls: this.running ? this.getPairingUrls() : [],
            clients: this.clientCount,
            clientList,
            clientDevices,
            error: this.error,
            note: '电视和现场电脑需处于同一局域网；电视端需要支持现代浏览器和 WebGL。'
        };
    }
}

module.exports = LanDisplayService;
