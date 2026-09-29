const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// The bundled Node host owns mysqld and observes IPC disconnect, so an unexpected
// Electron exit also shuts down only this application's private database.
class MysqlRuntime {
    constructor(options) { this.options = options; this.child = null; this.stopping = false; }

    async start() {
        const { root, runtimeDir, nodeBinary, hostScript, dependenciesDir, templateFile, onProgress } = this.options;
        const configFile = path.join(root, 'data', 'database-config.json');
        if (fs.existsSync(configFile)) {
            let config;
            try { config = JSON.parse(await fs.promises.readFile(configFile, 'utf8')); }
            catch { throw new Error('数据库配置文件无法读取，请检查 database-config.json；现有文件未被覆盖'); }
            if (config.managedBy !== 'desktop-mysql') return null;
        }
        await fs.promises.mkdir(path.join(root, 'mysql'), { recursive: true });
        await fs.promises.mkdir(path.join(root, 'logs'), { recursive: true });
        const requestFile = path.join(root, 'mysql', 'host-config.json');
        await fs.promises.writeFile(requestFile, JSON.stringify({ root, runtimeDir, templateFile }), { mode: 0o600 });
        const log = fs.openSync(path.join(root, 'logs', 'mysql-host.log'), 'a');
        try {
            this.child = spawn(nodeBinary, [hostScript, '--config', requestFile], {
                windowsHide: true,
                env: { ...process.env, NODE_PATH: dependenciesDir },
                stdio: ['ignore', log, log, 'ipc']
            });
        } finally { fs.closeSync(log); }
        const child = this.child;
        child.on('error', () => {});
        this.completion = new Promise(resolve => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
            child.once('error', error => resolve({ error: error.message }));
        });
        return new Promise((resolve, reject) => {
            let ready = false;
            const timeout = setTimeout(() => {
                this.stop().catch(() => {});
                reject(new Error('随包 MySQL 准备超时，请查看 mysql-host.log 和 mysql-server.log'));
            }, 180000);
            const finish = callback => value => { clearTimeout(timeout); callback(value); };
            child.on('message', message => {
                if (message.type === 'progress') onProgress?.(message.detail);
                if (message.type === 'ready') { ready = true; finish(resolve)(message.config); }
                if (message.type === 'error') finish(reject)(new Error(message.message));
            });
            child.once('error', finish(reject));
            child.once('exit', finish(reject).bind(null, new Error('随包 MySQL 进程已退出，请查看 mysql-host.log 和 mysql-server.log')));
            child.once('exit', () => {
                if (ready && !this.stopping) this.options.onUnexpectedExit?.(new Error('随包 MySQL 意外退出，请重新启动软件并查看 mysql-server.log'));
            });
        });
    }

    async stop() {
        if (this.stopPromise) return this.stopPromise;
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        this.stopping = true;
        this.stopPromise = (async () => {
            if (child.connected) child.send({ type: 'shutdown' }, () => {});
            let timer;
            const exited = await Promise.race([
                this.completion.then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })
            ]).finally(() => clearTimeout(timer));
            if (!exited) {
                await this.forceStop();
                throw new Error('随包 MySQL 未在限定时间内退出，已结束本程序的数据库进程树');
            }
        })();
        return this.stopPromise;
    }

    async forceStop() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, resolve));
    }
}

module.exports = { MysqlRuntime };
