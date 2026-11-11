'use strict';
// Owned by the display process: serve its own UI and forward data to ONE
// configured service. No database, PLC reader, service control or failover.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
    '.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon',
    '.woff2':'font/woff2','.wasm':'application/wasm','.mp3':'audio/mpeg' };
const dataPath = value => /^\/(?:api(?:\/|$)|ws(?:\?|$)|uploads(?:\/|$)|assets\/(?:models|motions)(?:\/|$))/.test(value);
async function startDisplayGateway({ backendOrigin, frontendDir, portFile }) {
    const target = new URL(backendOrigin);
    if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
        throw Error('Invalid collector origin');
    const root = path.resolve(frontendDir), sockets = new Set(), requests = new Set();
    if (!fs.existsSync(path.join(root,'index.html'))) throw Error('大屏自身的界面资源不完整');
    let port=0;
    if(portFile && fs.existsSync(portFile)) {
        const saved=JSON.parse(fs.readFileSync(portFile,'utf8'));
        if(saved.version!==1 || !Number.isInteger(saved.port) || saved.port<1024 || saved.port>65535) throw Error('大屏界面端口配置无效，未覆盖原配置');
        port=saved.port;
    }
    let origin, closing = false;
    const transport = target.protocol === 'https:' ? https : http;
    const valid = req => req.headers.host === new URL(origin).host
        && (!req.headers.origin || req.headers.origin === origin)
        && req.headers['sec-fetch-site'] !== 'cross-site';
    const headers = req => {
        const result = { ...req.headers, host: target.host };
        // The gateway first checks the real browser origin. Only then translate
        // it for the upstream's existing Origin + cookie + CSRF policy.
        if (result.origin) result.origin = target.origin;
        if (result.referer) result.referer = target.origin + '/';
        for (const name of Object.keys(result)) if (/^(forwarded|x-forwarded-|proxy-)/i.test(name)) delete result[name];
        return result;
    };
    const failed = res => { if (!res.headersSent) res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); if (!res.writableEnded) res.end(JSON.stringify({error:'采集数据服务未连接；未切换到本机数据库或模拟数据'})); };
    const server = http.createServer(async (req,res) => {
        if (!valid(req)) { res.writeHead(403); res.end(); return; }
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url,origin).pathname); } catch { res.writeHead(400); res.end(); return; }
        if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) { res.writeHead(400);res.end();return; }
        if (dataPath(req.url)) {
            if (/^\/api\/internal(?:\/|$)/.test(pathname)) { res.writeHead(403);res.end();return; }
            const upstream = transport.request(new URL(req.url,target.origin), { method:req.method,headers:headers(req) }, response => {
                const out = { ...response.headers };
                // Cookies remain HttpOnly/SameSite and keep their scoped names.
                // Only the local 127.0.0.1 UI leg is HTTP; HTTPS upstream keeps
                // normal certificate validation. Never expose an open proxy.
                if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(cookie => cookie.replace(/;\s*Domain=[^;]*/ig,'').replace(/;\s*Secure\b/ig,''));
                if (out.location) { try { const location = new URL(out.location,target); if (location.origin === target.origin) out.location = origin + location.pathname + location.search + location.hash; } catch {} }
                res.writeHead(response.statusCode,out); pipeline(response,res,()=>{});
            });
            requests.add(upstream);upstream.once('close',()=>requests.delete(upstream));
            upstream.setTimeout(120000,()=>upstream.destroy());upstream.on('error',()=>failed(res));
            req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if (!res.writableFinished) upstream.destroy();});
            pipeline(req,upstream,()=>{});return;
        }
        if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405);res.end();return; }
        let file = path.resolve(root,'.'+pathname);
        if (!file.startsWith(root+path.sep)) { file = path.join(root,'index.html'); }
        try { if (!(await fs.promises.stat(file)).isFile()) throw Error(); }
        catch { if (path.extname(pathname)) {res.writeHead(404);res.end();return;} file=path.join(root,'index.html'); }
        const stat=await fs.promises.stat(file);
        res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','content-length':stat.size,
            'cache-control':path.extname(file)==='.html'?'no-store':'public, max-age=86400','x-content-type-options':'nosniff',
            'content-security-policy':"frame-ancestors 'self'"});
        if(req.method==='HEAD') res.end();else pipeline(fs.createReadStream(file),res,()=>{});
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    server.on('upgrade',(req,socket,head)=>{
        if (!valid(req) || !/^\/ws(?:\?|$)/.test(req.url)) {socket.destroy();return;}
        const upstream=transport.request(new URL(req.url,target.origin),{headers:headers(req)});
        requests.add(upstream);upstream.once('close',()=>requests.delete(upstream));upstream.on('error',()=>socket.destroy());
        upstream.on('upgrade',(response,remote,remoteHead)=>{
            remote.setTimeout(0);
            sockets.add(remote);remote.once('close',()=>sockets.delete(remote));
            socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`+response.rawHeaders.reduce((text,value,i,values)=>i%2?text:text+`${value}: ${values[i+1]}\r\n`,'')+'\r\n');
            if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);
            socket.pipe(remote);remote.pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
            socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());
        });
        upstream.on('response',()=>socket.destroy());upstream.setTimeout(10000,()=>upstream.destroy());upstream.end();
    });
    await new Promise((resolve,reject)=>{server.once('error',error=>reject(error.code==='EADDRINUSE'?Error(`大屏界面端口 ${port} 已被占用，未切换界面地址或连接其他程序`):error));server.listen(port,'127.0.0.1',resolve);});
    origin=`http://127.0.0.1:${server.address().port}`;
    if(portFile && !port) {
        try {
            await fs.promises.mkdir(path.dirname(portFile),{recursive:true});
            const temporary=portFile+`.${process.pid}.tmp`;
            await fs.promises.writeFile(temporary,JSON.stringify({version:1,port:server.address().port}),{mode:0o600});
            await fs.promises.rename(temporary,portFile);
        } catch(error) {await new Promise(resolve=>server.close(resolve));throw error;}
    }
    return {origin,close:async()=>{
        if(closing)return;closing=true;
        for(const request of requests)request.destroy();for(const socket of sockets)socket.destroy();
        await new Promise(resolve=>server.close(resolve));
    }};
}
module.exports={startDisplayGateway};
