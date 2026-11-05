/**
 * 局域网电视发现（SSDP / UPnP）。
 *
 * 手机投屏之所以“能直接看到电视名字”，靠的就是 SSDP：往组播地址
 * 239.255.255.250:1900 发一条 M-SEARCH，局域网内的 MediaRenderer（绝大多数
 * 智能电视、电视盒子、AV 功放）会用 UDP 回一个带 LOCATION 的响应，再去
 * LOCATION 取一份设备描述 XML，就拿到了 friendlyName 和 AVTransport 控制地址。
 *
 * 只用 Node 内置的 dgram / http，不引入任何依赖。
 */

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const { stableCastId } = require('./castHistory');
const { URL } = require('url');
const {
    allHostIpv4Addresses,
    isBenchmarkIpv4,
    listLanIpv4Interfaces
} = require('../utils/lanNetwork');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
    'urn:schemas-upnp-org:device:MediaRenderer:1',
    'urn:schemas-upnp-org:device:MediaRenderer:2',
    'urn:schemas-upnp-org:service:AVTransport:1',
    'urn:schemas-upnp-org:service:AVTransport:2'
];
// 设备描述抓取超时。电视的内嵌 HTTP 服务通常很慢，但也不该让后台一直等。
const DESCRIPTION_TIMEOUT_MS = 4000;
// 一次没应答不代表电视掉线（组播丢包很常见），保留一段时间再从列表里移除。
const DEVICE_RETENTION_MS = 120_000;

function localIpv4Addresses() {
    return listLanIpv4Interfaces().map(entry => entry.address);
}

function ignoredDeviceReason(device, {
    hostAddresses = allHostIpv4Addresses(),
    hostname = os.hostname()
} = {}) {
    const address = String(device?.address || '');
    const localAddresses = new Set(hostAddresses);
    const identity = `${device?.manufacturer || ''} ${device?.modelName || ''}`;
    const name = String(device?.friendlyName || device?.name || '').trim();

    if (address && localAddresses.has(address)) return '本机媒体渲染器';
    if (/Microsoft Corporation/i.test(identity)
        && /Windows Digital Media Renderer/i.test(identity)
        && name.localeCompare(hostname, undefined, { sensitivity: 'accent' }) === 0) {
        return '本机 Windows 媒体渲染器';
    }
    if (isBenchmarkIpv4(address)) return '代理或虚拟网卡媒体设备';
    return '';
}

function parseSsdpHeaders(message) {
    const headers = {};
    const lines = String(message).split(/\r?\n/);
    for (const line of lines.slice(1)) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        headers[line.slice(0, index).trim().toUpperCase()] = line.slice(index + 1).trim();
    }
    return headers;
}

function firstTagText(xml, tag) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
    return match ? decodeXmlEntities(match[1].trim()) : '';
}

function decodeXmlEntities(value) {
    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        // 电视上报的中文名（「客厅的电视」这类）常用十六进制实体，必须一并解码。
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&');
}

/** 描述 XML 里的 controlURL 可能是相对路径，必须按 URLBase 或 LOCATION 补全。 */
function resolveUrl(base, relative) {
    if (!relative) return '';
    try {
        return new URL(relative, base).toString();
    } catch (error) {
        return '';
    }
}

function parseServices(xml, baseUrl) {
    const services = [];
    const blocks = xml.match(/<service(?:\s[^>]*)?>[\s\S]*?<\/service>/gi) || [];
    for (const block of blocks) {
        const type = firstTagText(block, 'serviceType');
        const controlUrl = resolveUrl(baseUrl, firstTagText(block, 'controlURL'));
        if (type && controlUrl) services.push({ type, controlUrl });
    }
    return services;
}

function httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (error) {
            reject(new Error(`设备描述地址无效：${url}`));
            return;
        }
        const client = target.protocol === 'https:' ? https : http;
        const request = client.get(target, { timeout: timeoutMs }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                httpGet(resolveUrl(url, response.headers.location), timeoutMs).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`设备描述返回 ${response.statusCode}`));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                // 描述文档只有几 KB，超过 1MB 一定不是我们要的东西。
                if (size > 1_048_576) {
                    request.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('设备描述读取超时')));
        request.on('error', reject);
    });
}

function friendlyBrand(device) {
    const text = `${device.manufacturer} ${device.modelName} ${device.friendlyName}`;
    if (/xiaomi|mi\s?tv|redmi/i.test(text)) return '小米电视';
    if (/huawei|honor|hisi/i.test(text)) return '华为智慧屏';
    if (/samsung|tizen/i.test(text)) return '三星电视';
    if (/\bLG\b|webos/i.test(text)) return 'LG 电视';
    if (/hisense/i.test(text)) return '海信电视';
    if (/skyworth|coocaa/i.test(text)) return '创维电视';
    if (/\bTCL\b/i.test(text)) return 'TCL 电视';
    if (/sony|bravia/i.test(text)) return '索尼电视';
    if (/changhong/i.test(text)) return '长虹电视';
    if (/konka/i.test(text)) return '康佳电视';
    if (/philips/i.test(text)) return '飞利浦电视';
    if (/chromecast|google/i.test(text)) return 'Chromecast';
    return '';
}

class CastDiscoveryService {
    constructor({ history = null } = {}) {
        this.history = history;
        /** @type {Map<string, object>} key 为设备 UDN 或 LOCATION */
        this.devices = new Map();
        this.lastScanAt = 0;
        this.scanning = null;
        this.lastError = '';
        this.ignoredDevices = [];
    }

    /**
     * 扫描局域网。并发在每张网卡上发 M-SEARCH，收集 LOCATION 后再抓描述 XML。
     * 同时只允许一次扫描在跑，重复调用会复用同一个 Promise。
     */
    async scan({ timeoutMs = 3500 } = {}) {
        if (this.scanning) return this.scanning;
        this.scanning = this._scan({ timeoutMs }).finally(() => { this.scanning = null; });
        return this.scanning;
    }

    async _scan({ timeoutMs }) {
        this.lastError = '';
        let locations;
        try {
            locations = await this._search(timeoutMs);
        } catch (error) {
            this.lastError = `局域网扫描失败：${error.message}`;
            return this.list();
        }

        const results = await Promise.all(
            Array.from(locations).map(location => this._describe(location).catch(() => null))
        );

        const now = Date.now();
        const ignoredDevices = [];
        for (const device of results) {
            if (!device) continue;
            const ignoreReason = ignoredDeviceReason(device);
            if (ignoreReason) {
                this.devices.delete(device.id);
                ignoredDevices.push({
                    id: device.id,
                    name: device.name,
                    address: device.address,
                    reason: ignoreReason
                });
                continue;
            }
            this.devices.set(device.id, { ...device, seenAt: now });
        }
        this.ignoredDevices = ignoredDevices;
        for (const [id, device] of this.devices) {
            if (now - device.seenAt > DEVICE_RETENTION_MS) this.devices.delete(id);
        }
        this.lastScanAt = now;
        if (!this.devices.size && !this.lastError) {
            this.lastError = ignoredDevices.length
                ? `已排除 ${ignoredDevices.length} 个本机或虚拟媒体设备，尚未搜到真实电视。请确认电视与本机连接同一路由器，并打开“DLNA / 多屏互动”。`
                : '没有搜到支持 DLNA 投屏的电视。请确认电视已开机、和本机在同一个局域网，并在电视设置里打开“DLNA / 多屏互动”。';
        }
        return this.list();
    }

    /** 返回本次搜索到的所有 LOCATION 地址。 */
    _search(timeoutMs) {
        const interfaces = localIpv4Addresses();
        const bindAddresses = interfaces.length ? interfaces : ['0.0.0.0'];
        const locations = new Set();

        const probes = bindAddresses.map(address => new Promise(resolve => {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                try { socket.close(); } catch (error) { /* 已关闭 */ }
                resolve();
            };

            socket.on('error', finish);
            socket.on('message', message => {
                const headers = parseSsdpHeaders(message.toString('utf8'));
                if (headers.LOCATION) locations.add(headers.LOCATION);
            });
            socket.bind({ address, port: 0 }, () => {
                try {
                    socket.setBroadcast(true);
                    socket.setMulticastTTL(4);
                    socket.setMulticastInterface(address === '0.0.0.0' ? '0.0.0.0' : address);
                } catch (error) {
                    // 某些虚拟网卡不支持组播设置，仍然尝试发包。
                }
                const mx = Math.max(1, Math.min(5, Math.round(timeoutMs / 1000)));
                for (const target of SEARCH_TARGETS) {
                    const payload = Buffer.from(
                        'M-SEARCH * HTTP/1.1\r\n'
                        + `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n`
                        + 'MAN: "ssdp:discover"\r\n'
                        + `MX: ${mx}\r\n`
                        + `ST: ${target}\r\n`
                        + '\r\n'
                    );
                    // 组播丢包很常见，同一条 M-SEARCH 发两遍能明显提高搜到率。
                    socket.send(payload, SSDP_PORT, SSDP_ADDRESS, () => {});
                    setTimeout(() => {
                        if (!settled) socket.send(payload, SSDP_PORT, SSDP_ADDRESS, () => {});
                    }, 250);
                }
                setTimeout(finish, timeoutMs);
            });
        }));

        return Promise.all(probes).then(() => locations);
    }

    async _describe(location) {
        const xml = await httpGet(location, DESCRIPTION_TIMEOUT_MS);
        const baseUrl = firstTagText(xml, 'URLBase') || location;
        const services = parseServices(xml, baseUrl);
        const avTransport = services.find(service => /:AVTransport:/i.test(service.type));
        if (!avTransport) return null;

        const renderingControl = services.find(service => /:RenderingControl:/i.test(service.type));
        const connectionManager = services.find(service => /:ConnectionManager:/i.test(service.type));
        const udn = firstTagText(xml, 'UDN');
        const friendlyName = firstTagText(xml, 'friendlyName') || '未命名设备';
        const manufacturer = firstTagText(xml, 'manufacturer');
        const modelName = firstTagText(xml, 'modelName');

        let address = '';
        try { address = new URL(location).hostname; } catch (error) { /* 保持为空 */ }

        const device = {
            id: stableCastId(udn) || udn || location,
            name: friendlyName,
            manufacturer,
            modelName,
            address,
            location,
            avTransportUrl: avTransport.controlUrl,
            avTransportType: avTransport.type,
            renderingControlUrl: renderingControl?.controlUrl || '',
            renderingControlType: renderingControl?.type || '',
            connectionManagerUrl: connectionManager?.controlUrl || '',
            connectionManagerType: connectionManager?.type || ''
        };
        device.brand = friendlyBrand(device);
        return device;
    }

    get(id) {
        const device = this.devices.get(id) || null;
        return device && Date.now() - device.seenAt <= DEVICE_RETENTION_MS && !ignoredDeviceReason(device) ? device : null;
    }

    async verify(device) {
        if (!device?.location) return null;
        const fresh = await this._describe(device.location).catch(() => null);
        if (fresh?.id === device.id && !ignoredDeviceReason(fresh)) {
            this.devices.set(fresh.id, { ...fresh, seenAt: Date.now() });
            return this.get(fresh.id);
        }
        this.devices.delete(device.id);
        return null;
    }

    async resolve(id) {
        // Re-read identity BEFORE sending SOAP. The old IP may now belong to another TV.
        const cached = this.get(id);
        const verified = cached ? await this.verify(cached) : null;
        if (verified) return verified;
        this.devices.delete(id);
        await this.scan({ timeoutMs: 3000 });
        // Only descriptors from THIS scan qualify, not a retained stale endpoint.
        const found = this.get(id);
        return found && found.seenAt === this.lastScanAt ? found : null;
    }

    list() {
        const history = new Map((this.history?.list() || []).map(device => [device.id, device]));
        const live = Array.from(this.devices.values())
            .filter(device => this.get(device.id))
            .map(device => ({
                id: device.id,
                name: device.name,
                brand: device.brand,
                manufacturer: device.manufacturer,
                modelName: device.modelName,
                address: device.address,
                seenAt: new Date(device.seenAt).toISOString(),
                available: true,
                remembered: history.has(device.id),
                lastCastAt: history.get(device.id)?.lastCastAt || ''
            }));
        const ids = new Set(live.map(device => device.id));
        const offline = [...history.values()].filter(device => !ids.has(device.id))
            .map(device => ({ ...device, remembered: true, available: false, address: '', seenAt: '' }));
        return [...live, ...offline].sort((a, b) => Number(b.remembered) - Number(a.remembered)
            || String(b.lastCastAt).localeCompare(String(a.lastCastAt)) || a.name.localeCompare(b.name, 'zh-CN'));
    }

    status() {
        return {
            devices: this.list(),
            interfaces: listLanIpv4Interfaces().map(entry => ({
                name: entry.name,
                address: entry.address
            })),
            scanning: Boolean(this.scanning),
            lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : '',
            error: this.lastError,
            historyError: this.history?.error || '',
            ignoredCount: this.ignoredDevices.length,
            ignoredDevices: this.ignoredDevices
        };
    }
}

module.exports = CastDiscoveryService;
module.exports.localIpv4Addresses = localIpv4Addresses;
module.exports.ignoredDeviceReason = ignoredDeviceReason;
