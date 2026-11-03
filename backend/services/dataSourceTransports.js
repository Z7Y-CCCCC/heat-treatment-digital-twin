// On-demand, read-only samples. No publish, SET, arbitrary SQL or network write commands.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const net = require('node:net'), dgram = require('node:dgram');
const { parseExternalPayload } = require('../utils/externalDataPayload');
const KINDS = new Set(['http', 'websocket', 'mqtt', 'tcp', 'udp', 'redis', 'file']);
const LIMIT = 262144, FILE_LIMIT = 1048576;
const root = path.resolve(process.env.APP_DATA_DIR || path.join(__dirname, '../data'), 'data-source-files');
const safeError = message => Object.assign(new Error(message), { userSafe: true });
function folder(factoryId) {
    if (!/^[\w-]{1,100}$/.test(String(factoryId))) throw safeError('工厂标识不正确');
    return path.join(root, factoryId);
}
function validateTransport(connection, factoryId) {
    const kind = connection.connector || 'http';
    if (!KINDS.has(kind) || kind === 'http') throw safeError('不支持此接入适配器');
    const auth = ({ websocket: ['none', 'basic', 'bearer'], mqtt: ['none', 'basic'], redis: ['none', 'basic'] })[kind] || ['none'];
    if (!auth.includes(connection.authType || 'none')) throw safeError('此适配器不支持所选认证方式');
    if (kind === 'file') {
        if (!/^[a-f0-9-]{36}\.(?:json|csv|xlsx)$/.test(connection.baseUrl)) throw safeError('请先导入 CSV / JSON / XLSX 数据文件');
        return { filename: path.join(folder(factoryId), connection.baseUrl) };
    }
    let url;
    try { url = new URL(connection.baseUrl); } catch { throw safeError('接入地址格式不正确'); }
    const protocols = { websocket: ['ws:', 'wss:'], mqtt: ['mqtt:', 'mqtts:'], tcp: ['tcp:'], udp: ['udp:'], redis: ['redis:', 'rediss:'] };
    if (!protocols[kind].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
        || /[\u0000-\u001f\u007f]/.test(connection.baseUrl)) throw safeError('接入地址协议不正确，或包含账号、密码、查询参数等不允许的内容');
    if (['tcp', 'udp'].includes(kind) && (!url.port || Number(url.port) < 1)) throw safeError('请填写有效端口');
    if (['tcp', 'udp', 'mqtt'].includes(kind) && url.pathname && url.pathname !== '/') throw safeError('地址只填写主机和端口；主题请单独填写');
    if (kind === 'redis' && !/^\/(?:\d{1,2})?$/.test(url.pathname)) throw safeError('Redis 地址路径只支持数据库编号，例如 /0');
    if (kind === 'udp' && !['127.0.0.1', '0.0.0.0', 'localhost'].includes(url.hostname)) throw safeError('UDP 为本机接收模式，地址仅支持 127.0.0.1 或 0.0.0.0');
    if (!String(connection.healthPath || '').trim() && ['mqtt', 'redis'].includes(kind)) throw safeError(kind === 'mqtt' ? '请填写订阅主题' : '请填写 Redis 键名');
    return { url };
}
function decode(buffer, format = 'auto') {
    if (buffer.length > LIMIT) throw safeError('单条数据超过 256 KB 上限');
    const text = buffer.toString('utf8').trim();
    let payload;
    try { payload = JSON.parse(text); }
    catch { payload = format === 'csv' || format === 'xml' ? parseExternalPayload(text, format) : { value: text }; }
    return payload !== null && typeof payload === 'object' ? payload : { value: payload };
}
function networkSample(connection, url, probe) {
    return new Promise((resolve, reject) => {
        const kind = connection.connector, timeout = connection.requestTimeoutMs || 8000;
        let done = false, stop = () => {}, chunks = [], size = 0;
        const timer = setTimeout(() => finish(Object.assign(safeError('等待数据超时，请检查服务及是否有数据发送'), { code: 'TIMEOUT' })), timeout);
        function finish(error, payload) {
            if (done) return; done = true; clearTimeout(timer); stop();
            if (error) reject(error.userSafe ? error : safeError('连接失败，请检查地址、服务、认证或端口占用'));
            else resolve(payload || { connected: true });
        }
        function message(buffer) { try { finish(null, decode(Buffer.from(buffer), connection.responseFormat)); } catch (error) { finish(error); } }
        try {
            if (kind === 'websocket') {
                const WebSocket = require('ws');
                const headers = connection.authType === 'bearer' ? { Authorization: `Bearer ${connection.token}` }
                    : connection.authType === 'basic' ? { Authorization: 'Basic ' + Buffer.from(`${connection.user}:${connection.password}`).toString('base64') } : {};
                const client = new WebSocket(url, { headers, maxPayload: LIMIT, handshakeTimeout: timeout, followRedirects: false });
                stop = () => client.terminate(); client.on('error', finish); client.on('message', message);
                client.on('open', () => { if (probe) finish(); });
                client.on('close', () => { if (!done) finish(safeError('WebSocket 已关闭，未收到数据')); });
            } else if (kind === 'mqtt') {
                const client = require('mqtt').connect(url.href, { username: connection.user || undefined, password: connection.password || undefined,
                    clientId: 'dt_read_' + crypto.randomBytes(6).toString('hex'), clean: true, connectTimeout: timeout,
                    reconnectPeriod: 0, queueQoSZero: false, protocolVersion: 4 });
                stop = () => client.end(true); client.on('error', finish); client.on('message', (_, payload) => message(payload));
                let incomingBytes = 0;
                client.stream.on('data', buffer => { incomingBytes += buffer.length; if (incomingBytes > LIMIT + 8192) finish(safeError('MQTT 数据超过取样大小上限')); });
                client.on('connect', () => client.subscribe(connection.healthPath, { qos: 0 }, (error, granted) => {
                    if (error || granted?.some(item => item.qos === 128)) finish(safeError('MQTT 主题订阅被拒绝'));
                    else if (probe) finish();
                }));
                client.on('close', () => { if (!done) finish(safeError('MQTT 连接已关闭，未收到数据')); });
            } else if (kind === 'tcp') {
                const client = net.createConnection({ host: url.hostname, port: Number(url.port) });
                stop = () => client.destroy(); client.on('error', finish);
                client.on('connect', () => { if (probe) finish(); });
                client.on('data', buffer => {
                    size += buffer.length; if (size > LIMIT) return finish(safeError('TCP 帧超过 256 KB 上限'));
                    chunks.push(buffer); const all = Buffer.concat(chunks);
                    const newline = all.indexOf(10);
                    if (newline >= 0) return message(all.subarray(0, newline));
                    try { JSON.parse(all.toString('utf8')); message(all); } catch { /* Wait for a complete JSON frame. */ }
                });
                client.on('end', () => size ? message(Buffer.concat(chunks)) : finish(safeError('TCP 已关闭，未收到数据')));
            } else if (kind === 'udp') {
                const client = dgram.createSocket('udp4'); stop = () => { try { client.close(); } catch {} };
                client.on('error', finish); client.on('message', message);
                client.bind(Number(url.port), url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, () => { if (probe) finish(); });
            }
        } catch (error) { finish(error); }
    });
}
async function readTransportOnce(connection, factoryId, { probe = false } = {}) {
    const { url, filename } = validateTransport(connection, factoryId);
    if (connection.connector === 'file') {
        const stat = await fs.promises.stat(filename).catch(() => { throw safeError('已导入的数据文件不存在'); });
        if (stat.size > FILE_LIMIT) throw safeError('文件超过 1 MB 上限');
        // Imported files are immutable, server-named copies, never arbitrary filesystem paths.
        const body = await fs.promises.readFile(filename);
        if (body.length > FILE_LIMIT) throw safeError('文件超过 1 MB 上限');
        const payload = filename.endsWith('.xlsx') ? await require('./excelDataFile').readExcelData(body, connection.healthPath)
            : parseExternalPayload(body.toString('utf8').replace(/^\uFEFF/, ''), filename.endsWith('.csv') ? 'csv' : 'json');
        return payload !== null && typeof payload === 'object' ? payload : { value: payload };
    }
    if (connection.connector === 'redis') {
        const client = require('redis').createClient({ url: url.href, username: connection.user || undefined, password: connection.password || undefined,
            socket: { connectTimeout: connection.requestTimeoutMs, reconnectStrategy: false }, disableOfflineQueue: true, commandsQueueMaxLength: 8 });
        client.on('error', () => {});
        let timer;
        try {
            const value = await Promise.race([(async () => {
                await client.connect();
                return probe ? client.ping() : client.getRange(connection.healthPath, 0, LIMIT);
            })(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(safeError('Redis 读取超时'), { code: 'TIMEOUT' })), connection.requestTimeoutMs); timer.unref();
            })]);
            return value === null ? { value: null } : decode(Buffer.from(value), connection.responseFormat);
        } catch (error) { if (error.code === 'TIMEOUT') throw error; throw safeError('Redis 连接或只读 GET 失败，请检查地址、ACL 和键名'); }
        finally { clearTimeout(timer); try { client.destroy(); } catch {} }
    }
    return networkSample(connection, url, probe);
}
const samples = new Map(), pending = new Map();
async function readTransport(connection, factoryId, options = {}) {
    if (options.probe) return readTransportOnce(connection, factoryId, options);
    const { health, createdAt, updatedAt, configRevision, name, ...settings } = connection;
    const key = crypto.createHash('sha256').update(JSON.stringify([factoryId, settings])).digest('hex');
    const now = Date.now();
    for (const [id, cached] of samples) if (cached.expires <= now) samples.delete(id);
    if (samples.has(key)) return samples.get(key).value;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) throw safeError('并发取样过多，请稍后重试');
    const promise = readTransportOnce(connection, factoryId, options).then(value => {
        while (samples.size >= 16) samples.delete(samples.keys().next().value);
        samples.set(key, { value, expires: Date.now() + 500 }); return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
}
async function importDataFile(buffer, originalName, factoryId) {
    const extension = path.extname(String(originalName)).toLowerCase();
    if (!['.json', '.csv', '.xlsx'].includes(extension) || !buffer?.length || buffer.length > FILE_LIMIT) throw safeError('仅支持 1 MB 以内的 CSV / JSON / XLSX 文件');
    const workbook = extension === '.xlsx' ? await require('./excelDataFile').readExcelData(buffer) : null;
    if (!workbook) parseExternalPayload(buffer.toString('utf8').replace(/^\uFEFF/, ''), extension.slice(1));
    const directory = folder(factoryId); fs.mkdirSync(directory, { recursive: true });
    const total = fs.readdirSync(directory).reduce((sum, item) => sum + fs.statSync(path.join(directory, item)).size, 0);
    if (total + buffer.length > 64 * FILE_LIMIT) throw safeError('当前工厂的数据文件已达到 64 MB 上限');
    const asset = crypto.randomUUID() + extension;
    fs.writeFileSync(path.join(directory, asset), buffer, { flag: 'wx', mode: 0o600 });
    return { asset, name: path.basename(String(originalName)), size: buffer.length, ...(workbook ? { sheets: workbook.sheets, sheet: workbook.sheet } : {}) };
}
module.exports = { KINDS, validateTransport, readTransport, importDataFile };
