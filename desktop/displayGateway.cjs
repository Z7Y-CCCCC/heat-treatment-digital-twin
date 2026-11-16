'use strict';
// Owned by the display process: serve its own UI and forward data to ONE
// configured service. No database, PLC reader, service control or failover.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
    '.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon',
    '.woff2':'font/woff2','.wasm':'application/wasm','.mp3':'audio/mpeg' };
const dataPath = value => /^\/(?:api(?:\/|$)|ws(?:\?|$)|uploads(?:\/|$)|assets\/(?:models|motions)(?:\/|$))/.test(value);
function gatewayListenError(error, port) {
    if (error.code === 'EACCES') return Object.assign(new Error(
        `Windows 拒绝监听本机界面端口 ${port}（可能处于系统保留端口段）；自动分配空闲界面端口未成功。采集服务与数据库未修改。`, { cause: error }),
        { code: 'DISPLAY_UI_PORT_DENIED', port });
    if (error.code === 'EADDRINUSE') return Object.assign(new Error(
        `大屏界面端口 ${port} 已被占用，自动分配空闲界面端口未成功；未连接或结束占用端口的程序`, { cause: error }),
        { code: 'DISPLAY_UI_PORT_BUSY', port });
    return error;
}
async function startDisplayGateway({ backendOrigin, frontendDir, portFile }) {
    const target = new URL(backendOrigin);
    if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
        throw Error('Invalid collector origin');
    const root = path.resolve(frontendDir), sockets = new Set(), requests = new Set();
    if (!fs.existsSync(path.join(root,'index.html'))) throw Error('大屏自身的界面资源不完整');
    let port=0, saved=null, savedBytes=null;
    if(portFile && fs.existsSync(portFile)) {
        savedBytes=fs.readFileSync(portFile); saved=JSON.parse(savedBytes);
        if(saved.version!==1 || !Number.isInteger(saved.port) || saved.port<1024 || saved.port>65535) throw Error('大屏界面端口配置无效，未覆盖原配置');
        const pending=saved.pendingOriginMigration;
        if(Object.hasOwn(saved,'pendingOriginMigration') && (!pending || typeof pending!=='object' || Array.isArray(pending) || !Number.isInteger(pending.fromPort)||pending.fromPort<1024||pending.fromPort>65535
            ||pending.toPort!==saved.port||pending.fromPort===pending.toPort)) throw Error('界面端口迁移记录无效，原配置与草稿保留');
        port=saved.port;
    }
    let origin, closing = false, pendingMigration=saved?.pendingOriginMigration || null;
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
        // No business UI is exposed at the new origin until both browser
        // profiles are migrated. A restart resumes this journal, not a blank UI.
        if (pendingMigration) {
            res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
            res.end(JSON.stringify({code:'UI_ORIGIN_MIGRATION_PENDING',error:'正在保留本地草稿和界面设置，请稍候'}));return;
        }
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
        if (pendingMigration || !valid(req) || !/^\/ws(?:\?|$)/.test(req.url)) {socket.destroy();return;}
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
    const listen = candidate => new Promise((resolve,reject)=>{
        const ready = () => {server.removeListener('error',failed);resolve();};
        const failed = error => {server.removeListener('listening',ready);reject(error);};
        server.once('error',failed);
        server.once('listening',ready);
        try {server.listen(candidate,'127.0.0.1');} catch(error) {server.removeListener('error',failed);failed(error);}
    });
    let recoveryCause=null;
    try { await listen(port); }
    catch(error) {
        if (!port || !['EACCES','EADDRINUSE'].includes(error.code)) throw gatewayListenError(error,port);
        recoveryCause=error;
        // Bind the alternative directly; do not probe then close, or another
        // process could take it between the availability check and startup.
        for (let attempt=0; ; attempt++) {
            try { await listen(0); break; }
            catch(failure) {
                if (attempt>=2 || !['EACCES','EADDRINUSE'].includes(failure.code)) throw gatewayListenError(failure,port);
            }
        }
    }
    origin=`http://127.0.0.1:${server.address().port}`;
    const assignedPort=server.address().port;
    const persist=async value=>{
        await fs.promises.mkdir(path.dirname(portFile),{recursive:true});
        if(savedBytes && !(await fs.promises.readFile(portFile)).equals(savedBytes)) throw Error('界面端口配置已被其他操作修改，未覆盖');
        if(!savedBytes && fs.existsSync(portFile)) throw Error('界面端口配置已被其他操作创建，未覆盖');
        const bytes=Buffer.from(JSON.stringify(value)),temporary=portFile+`.${process.pid}.${crypto.randomUUID()}.tmp`;
        try { await fs.promises.writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await fs.promises.rename(temporary,portFile);savedBytes=bytes; }
        finally { await fs.promises.unlink(temporary).catch(()=>{}); }
    };
    if(portFile && (!port || recoveryCause)) {
        try {
            if(recoveryCause) {
                const fromPort=pendingMigration?.fromPort || port;
                // The old owner may exit between the failed bind and listen(0).
                // Returning to the ORIGINAL origin needs no cross-origin copy.
                pendingMigration=fromPort===assignedPort ? null : {fromPort,toPort:assignedPort};
                const backup=path.join(path.dirname(portFile),'recovery','ui-port-'+Date.now()+'-'+crypto.randomUUID()+'.before.json');
                await fs.promises.mkdir(path.dirname(backup),{recursive:true});await fs.promises.writeFile(backup,savedBytes,{mode:0o600,flag:'wx'});
            }
            await persist({version:1,port:assignedPort,...(pendingMigration?{pendingOriginMigration:pendingMigration}:{})});
        } catch(error) {await new Promise(resolve=>server.close(resolve));throw error;}
    }
    return {origin,originMigration:pendingMigration ? Object.freeze({
        fromOrigin:`http://127.0.0.1:${pendingMigration.fromPort}`,toOrigin:origin
    }):null,
    completeOriginMigration:async()=>{
        if(!pendingMigration)return;
        await persist({version:1,port:assignedPort});pendingMigration=null;
    },close:async()=>{
        if(closing)return;closing=true;
        for(const request of requests)request.destroy();for(const socket of sockets)socket.destroy();
        await new Promise(resolve=>server.close(resolve));
    }};
}
module.exports={startDisplayGateway,gatewayListenError};
