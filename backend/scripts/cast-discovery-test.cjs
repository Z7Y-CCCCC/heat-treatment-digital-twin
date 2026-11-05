/**
 * 局域网电视发现 + DLNA 一键投屏的离线自测。
 *
 * 不依赖现场真有一台电视：用本地 HTTP 服务分别扮演
 *   1) 电视的设备描述端点（UPnP device description XML）
 *   2) 电视的 AVTransport 控制端点（SOAP）
 * 覆盖描述解析、相对 controlURL 补全、SOAP 报文正确性、错误回报、
 * 多网卡下的本机地址选择，以及“没有 ffmpeg 时必须明确报错”。
 *
 * 运行: npm run test:cast
 */

const assert = require('assert');
const http = require('http');

const CastDiscoveryService = require('../services/castDiscovery');
const ScreenCastService = require('../services/screenCast');
const dlna = require('../services/dlnaClient');
const { listLanIpv4Interfaces } = require('../utils/lanNetwork');

const { pickLocalAddressFor, buildEncoderArgs } = ScreenCastService;
const { ignoredDeviceReason } = CastDiscoveryService;

const DEVICE_DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>&#x5BA2;&#x5385;&#x7684;&#x7535;&#x89C6;</friendlyName>
    <manufacturer>Hisense</manufacturer>
    <modelName>HZ65E8D</modelName>
    <UDN>uuid:11112222-3333-4444-5555-666677778888</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>upnp/control/AVTransport1</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <controlURL>/upnp/control/ConnectionManager1</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('设备描述解析出电视名、品牌和 AVTransport 控制地址', async () => {
    const server = http.createServer((req, res) => {
        assert.strictEqual(req.url, '/dmr/description.xml', '发现服务应该请求 LOCATION 原始路径');
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(DEVICE_DESCRIPTION);
    });
    const port = await listen(server);
    try {
        const discovery = new CastDiscoveryService();
        const location = `http://127.0.0.1:${port}/dmr/description.xml`;
        const device = await discovery._describe(location);

        assert.ok(device, '应当解析出设备');
        assert.strictEqual(device.name, '客厅的电视', 'friendlyName 的 XML 实体应当被解码');
        assert.strictEqual(device.brand, '海信电视', '应当按厂商识别出中文品牌名');
        assert.strictEqual(device.modelName, 'HZ65E8D');
        assert.strictEqual(device.address, '127.0.0.1');
        assert.strictEqual(device.id, 'uuid:11112222-3333-4444-5555-666677778888', '应当用 UDN 作为稳定 ID');
        assert.strictEqual(
            device.avTransportUrl,
            `http://127.0.0.1:${port}/dmr/upnp/control/AVTransport1`,
            '相对 controlURL 必须按 LOCATION 补全'
        );
        assert.strictEqual(
            device.renderingControlUrl,
            `http://127.0.0.1:${port}/upnp/control/RenderingControl1`,
            '绝对路径 controlURL 应当挂在根上'
        );
        assert.strictEqual(
            device.connectionManagerUrl,
            `http://127.0.0.1:${port}/upnp/control/ConnectionManager1`,
            '应保留 ConnectionManager，用于读取电视支持的媒体类型'
        );
    } finally {
        await close(server);
    }
});

check('没有 AVTransport 的设备（如纯音箱、打印机）被过滤掉', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(DEVICE_DESCRIPTION.replace(/urn:schemas-upnp-org:service:AVTransport:1/, 'urn:schemas-upnp-org:service:ConnectionManager:1'));
    });
    const port = await listen(server);
    try {
        const discovery = new CastDiscoveryService();
        const device = await discovery._describe(`http://127.0.0.1:${port}/d.xml`);
        assert.strictEqual(device, null, '不能投屏的设备不应出现在电视列表里');
    } finally {
        await close(server);
    }
});

check('本机 Windows 媒体渲染器不会冒充电视', () => {
    const reason = ignoredDeviceReason({
        name: 'FACTORY-PC',
        manufacturer: 'Microsoft Corporation',
        modelName: 'Windows Digital Media Renderer',
        address: '198.18.0.1'
    }, {
        hostname: 'FACTORY-PC',
        hostAddresses: ['192.168.2.20', '198.18.0.1']
    });
    assert.match(reason, /本机/, '本机媒体渲染器应被明确识别并过滤');
});

check('电视发现优先使用真实局域网卡并排除 Clash / Hyper-V 虚拟网卡', () => {
    const interfaces = listLanIpv4Interfaces({
        '以太网': [{ family: 'IPv4', internal: false, address: '192.168.2.20', netmask: '255.255.255.0' }],
        'Clash': [{ family: 'IPv4', internal: false, address: '198.18.0.1', netmask: '255.254.0.0' }],
        'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.22.16.1', netmask: '255.255.240.0' }]
    });
    assert.deepStrictEqual(interfaces.map(entry => entry.address), ['192.168.2.20']);
});

check('SetAVTransportURI / Play 发出的 SOAP 报文电视能认', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            received.push({
                soapAction: req.headers.soapaction,
                contentType: req.headers['content-type'],
                body: Buffer.concat(chunks).toString('utf8')
            });
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>');
        });
    });
    const port = await listen(server);
    try {
        const device = {
            id: 'tv',
            name: '测试电视',
            avTransportUrl: `http://127.0.0.1:${port}/ctrl`,
            avTransportType: 'urn:schemas-upnp-org:service:AVTransport:1'
        };
        await dlna.startPlayback(device, { url: 'http://192.168.1.9:8788/cast/abc/live.ts', title: '大屏' });

        const actions = received.map(entry => entry.soapAction);
        assert.deepStrictEqual(
            actions,
            [
                '"urn:schemas-upnp-org:service:AVTransport:1#Stop"',
                '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"',
                '"urn:schemas-upnp-org:service:AVTransport:1#Play"'
            ],
            '必须先 Stop 清掉上一次会话，再 SetAVTransportURI，最后 Play'
        );

        const setUri = received[1];
        assert.match(setUri.contentType, /text\/xml/, 'SOAP 必须声明 text/xml');
        assert.match(setUri.body, /<InstanceID>0<\/InstanceID>/);
        assert.match(setUri.body, /<CurrentURI>http:\/\/192\.168\.1\.9:8788\/cast\/abc\/live\.ts<\/CurrentURI>/);
        assert.match(setUri.body, /DLNA\.ORG_FLAGS=8D500000/, '直播流必须带 DLNA 实时流标记，否则不少电视会拒播');
        assert.match(setUri.body, /object\.item\.videoItem/);
        assert.match(received[2].body, /<Speed>1<\/Speed>/);
    } finally {
        await close(server);
    }
});

check('电视返回 SOAP 错误时，把电视自己的错误描述透出来', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(500, { 'Content-Type': 'text/xml' });
            res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>'
                + '<detail><UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail>'
                + '</s:Fault></s:Body></s:Envelope>');
        });
    });
    const port = await listen(server);
    try {
        const device = {
            avTransportUrl: `http://127.0.0.1:${port}/ctrl`,
            avTransportType: 'urn:schemas-upnp-org:service:AVTransport:1'
        };
        await assert.rejects(
            () => dlna.stopPlayback(device),
            error => {
                assert.match(error.message, /Transition not available/, '错误信息应包含电视的原始描述');
                assert.match(error.message, /701/, '错误信息应包含 UPnP 错误码');
                return true;
            }
        );
    } finally {
        await close(server);
    }
});

check('电视拒绝完整 DLNA 元数据时自动用空元数据兼容重试', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ action: req.headers.soapaction, body });
            const isFirstMetadataAttempt = /#SetAVTransportURI"$/.test(req.headers.soapaction || '')
                && /<CurrentURIMetaData>.+<\/CurrentURIMetaData>/.test(body);
            if (isFirstMetadataAttempt) {
                res.writeHead(500, { 'Content-Type': 'text/xml' });
                res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>714</errorCode><errorDescription>Illegal MIME-Type</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end('<s:Envelope><s:Body/></s:Envelope>');
        });
    });
    const port = await listen(server);
    try {
        const result = await dlna.startPlayback({
            avTransportUrl: `http://127.0.0.1:${port}/ctrl`,
            avTransportType: 'urn:schemas-upnp-org:service:AVTransport:1'
        }, {
            url: 'http://192.168.1.9/live.ts',
            title: '大屏',
            mimeType: 'video/mpeg'
        });
        assert.strictEqual(result.metadataMode, 'empty');
        const setUriRequests = requests.filter(item => /SetAVTransportURI/.test(item.action));
        assert.strictEqual(setUriRequests.length, 2);
        assert.match(setUriRequests[1].body, /<CurrentURIMetaData><\/CurrentURIMetaData>/);
        assert.match(requests.at(-1).action, /#Play/);
    } finally {
        await close(server);
    }
});

check('按电视声明选择 MPEG-TS 的兼容 Content-Type', () => {
    assert.strictEqual(dlna.chooseVideoMimeType(['http-get:*:video/mp2t:*']), 'video/mp2t');
    assert.strictEqual(dlna.chooseVideoMimeType(['http-get:*:video/mpeg:*']), 'video/mpeg');
    assert.strictEqual(dlna.chooseVideoMimeType([]), 'video/mp2t');
    assert.match(
        dlna.buildLiveVideoMetadata({ url: 'http://host/live.ts', title: '大屏', mimeType: 'video/mpeg' }),
        /http-get:\*:video\/mpeg:/
    );
});

check('多网卡时按子网挑选本机地址', () => {
    const address = pickLocalAddressFor('127.0.0.1');
    assert.ok(typeof address === 'string', '应当返回一个字符串地址');
    // 本机至少要能给出一个可用的局域网地址，否则投屏 URL 无从生成。
    assert.ok(address.length > 0, '本机应当有可用的 IPv4 地址');
    assert.ok(!/^169\.254\./.test(address), '不能选到 APIPA 自动地址');
    assert.strictEqual(pickLocalAddressFor('').length > 0, true, '目标未知时也要能退回到一个私网地址');
});

check('缺少 ffmpeg 时投屏必须明确失败而不是静默假成功', async () => {
    const service = new ScreenCastService({ port: 0 });
    service.ffmpegChecked = true;
    service.ffmpegCheckedAt = Date.now();
    service.ffmpegPath = '';
    await assert.rejects(
        () => service.start({ id: 'tv', name: '测试电视', address: '127.0.0.1', avTransportUrl: 'http://127.0.0.1:1/ctrl' }),
        error => {
            assert.match(error.message, /ffmpeg/i, '错误信息要点名 ffmpeg，工程师才知道装什么');
            return true;
        }
    );
    assert.strictEqual(service.status().casting, false, '失败后不应留下投屏会话');
    assert.strictEqual(service.status().ffmpegAvailable, false);
});

check('编码器只裁剪 Unity 窗口区域并使用 LGPL 兼容的 h264_mf', () => {
    const bounds = { left: 100, top: 50, width: 1600, height: 900 };
    const args = buildEncoderArgs({
        frameRate: 20,
        width: 1920,
        height: 1080,
        bitrateKbps: 8000
    }, bounds);
    const inputIndex = args.indexOf('-i');
    const encoderIndex = args.indexOf('-c:v');
    assert.strictEqual(args[inputIndex + 1], 'desktop', 'DirectX 与 WebView2 合成画面必须从桌面捕获');
    assert.strictEqual(args[args.indexOf('-offset_x') + 1], '100');
    assert.strictEqual(args[args.indexOf('-offset_y') + 1], '50');
    assert.strictEqual(args[args.indexOf('-video_size') + 1], '1600x900');
    assert.ok(!args.some(value => String(value).startsWith('title=')), '不能再使用抓不到 DirectX 的 title 模式');
    assert.strictEqual(args[encoderIndex + 1], 'h264_mf', 'Windows 无独显电脑应使用 Media Foundation');
    assert.strictEqual(args[args.indexOf('-profile:v') + 1], '77', '电视兼容档应固定为 H.264 Main Profile');
    assert.strictEqual(args[args.indexOf('-level:v') + 1], '41', '1080p 直播应限制在常见电视支持的 Level 4.1');
    assert.ok(!args.includes('libx264'), '商业交付链路不能意外依赖 GPL libx264');
    assert.ok(args.includes('format=nv12') || args.some(value => String(value).includes('format=nv12')),
        'h264_mf 输入应转换为兼容的 NV12');
});

check('没有 AVTransport 地址的设备直接拒绝，不去起编码器', async () => {
    const service = new ScreenCastService({ port: 0 });
    await assert.rejects(
        () => service.start({ id: 'x', name: '无控制地址', address: '127.0.0.1' }),
        /AVTransport/
    );
});

check('投屏排除顶端标签栏：普通模式按 DPI 裁切，纯画面模式不重复裁切', () => {
    for (const chromeHeight of [46, 69, 92]) {
        const args = buildEncoderArgs({}, { left: 100, top: 50, width: 1600, height: 900, chromeHeight });
        assert.match(args[args.indexOf('-vf') + 1], new RegExp(`^crop=iw:${900 - chromeHeight}:0:${chromeHeight},`));
    }
    const args = buildEncoderArgs({}, { left: 100, top: 50, width: 1600, height: 900, chromeHeight: 0 });
    assert.doesNotMatch(args[args.indexOf('-vf') + 1], /crop=/);
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../native-admin-host/AdminPanelForm.cs'), 'utf8');
    const presentation = source.slice(source.indexOf('private void PrepareCastPresentation()'), source.indexOf('private void RestoreCastPresentation()'));
    assert.match(presentation, /HideDetachedDashboardChrome\(\)/);
    assert.match(presentation, /SetPresentationMode\(true\)/);
    assert.match(presentation, /ShowWindow\(Handle, NativeMethods\.SwHide\)/);
});

check('投屏流服务只响应带 token 的路径', async () => {
    const service = new ScreenCastService({ port: 0 });
    service.ffmpegChecked = true;
    service.ffmpegPath = '';
    await service.ensureStreamServer();
    service.session = {
        device: null,
        deviceId: 'test',
        deviceName: '测试电视',
        deviceAddress: '127.0.0.1',
        url: '',
        state: 'casting',
        startedAt: Date.now(),
        viewers: 0
    };
    const port = service.server.address().port;
    try {
        assert.ok(/^\/cast\/[0-9a-f]{24}\/live\.ts$/.test(service.streamPath()), '流路径应当带一段随机 token');

        const wrong = await new Promise(resolve => {
            http.get({ host: '127.0.0.1', port, path: '/cast/live.ts' }, res => { res.resume(); resolve(res.statusCode); });
        });
        assert.strictEqual(wrong, 404, '猜不到 token 的请求必须拿不到画面');

        const head = await new Promise(resolve => {
            const req = http.request({ host: '127.0.0.1', port, path: service.streamPath(), method: 'HEAD' }, res => {
                res.resume();
                resolve(res.headers);
            });
            req.end();
        });
        assert.strictEqual(head['content-type'], 'video/mp2t');
        assert.match(String(head['contentfeatures.dlna.org']), /DLNA\.ORG_FLAGS=8D500000/, '流响应头也要声明是实时流');
    } finally {
        await service.close();
    }
});

async function main() {
    let failed = 0;
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (error) {
            failed += 1;
            console.error(`  ✗ ${name}`);
            console.error(`    ${error.message}`);
        }
    }
    console.log('');
    if (failed) {
        console.error(`投屏自测未通过：${failed}/${checks.length} 项失败`);
        process.exitCode = 1;
        return;
    }
    console.log(`投屏自测全部通过（${checks.length} 项）`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
