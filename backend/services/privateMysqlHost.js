const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { seedMysql } = require('./mysqlSeed');
const { BoundedProcessLog } = require('../utils/boundedProcessLog');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `\`${String(value).replace(/`/g, '``')}\``;
let server;
let serverExit;
let credentials;
let stopping = false;
let shutdownPromise;

function send(message) { if (process.connected) process.send(message, () => {}); }
function progress(detail) { console.log(detail); send({ type: 'progress', detail }); }
function atomicJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filename);
}
function checkRunning() { if (stopping) throw new Error('程序正在退出，已取消数据库准备'); }
function readJson(filename) {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch { throw new Error(`无法读取数据库状态文件 ${path.basename(filename)}；现有文件未被覆盖`); }
}

function mysqlAsciiPaths(mysqlRoot, runtimeDirectory) {
    // MySQL on Windows reparses its command line with the ANSI code page.
    // Junctions keep every native argument ASCII even for Chinese user/install
    // directories, while all actual data stays in the original userData tree.
    const runtime = fs.realpathSync(runtimeDirectory);
    const storage = fs.realpathSync(mysqlRoot);
    const token = crypto.createHash('sha256').update(`${storage}\n${runtime}`).digest('hex').slice(0, 32);
    const programData = path.resolve(process.env.ProgramData || 'C:\\ProgramData');
    const aliasRoot = path.join(programData, 'HeatTreatmentDigitalTwin', 'mysql-links', token);
    if (!/^[\x20-\x7e]+$/.test(aliasRoot)) throw new Error('MySQL 兼容路径必须为英文，请将 ProgramData 设置为英文目录');
    fs.mkdirSync(aliasRoot, { recursive: true });
    const link = (name, target) => {
        const filename = path.join(aliasRoot, name);
        let existing;
        try { existing = fs.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing) {
            if (!existing.isSymbolicLink() || fs.realpathSync(filename).toLowerCase() !== target.toLowerCase()) {
                throw new Error('MySQL 兼容路径被其他目录占用，现有目录未被改动');
            }
        } else {
            fs.symlinkSync(target, filename, 'junction');
        }
        return filename;
    };
    return { root: aliasRoot, runtime: link('runtime', runtime), storage: link('storage', storage) };
}

async function freePort(preferred) {
    for (let index = 0; index < 50; index++) {
        const port = Number(preferred || 13307) + index;
        try {
            await new Promise((resolve, reject) => {
                const socket = net.createServer();
                socket.once('error', reject);
                socket.listen(port, '127.0.0.1', () => socket.close(resolve));
            });
            return port;
        } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    throw new Error('没有可用的本机 MySQL 端口');
}

function launch(executable, args, logFile) {
    checkRunning();
    const log = new BoundedProcessLog(logFile);
    log.on('error', error => console.error(`MySQL server log: ${error.message}`));
    try {
        server = spawn(executable, args, { windowsHide: true, argv0: 'mysqld.exe', cwd: path.dirname(executable), stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
        server.once('close', () => log.end());
    } catch (error) { log.end(); throw error; }
    serverExit = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', (code, signal) => resolve({ code, signal }));
    });
    serverExit.catch(() => {});
    return server;
}

async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
        if (server && server.exitCode === null && server.signalCode === null) {
            if (credentials) {
                let connection;
                try {
                    connection = await mysql.createConnection({ ...credentials, connectTimeout: 3000 });
                    await connection.query('SHUTDOWN');
                } catch (error) {
                    if (!['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code)) console.error(`MySQL shutdown: ${error.code || error.message}`);
                } finally { if (connection) await connection.end().catch(() => {}); }
            } else {
                server.kill(); // Only an unfinished initialization process.
            }
            let timer;
            const exited = await Promise.race([
                serverExit.then(() => true, () => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })
            ]).finally(() => clearTimeout(timer));
            if (!exited) { server.kill(); await serverExit; }
        }
    })();
    return shutdownPromise;
}

async function main() {
    if (process.argv[2] !== '--config' || !process.argv[3]) throw new Error('Private MySQL host requires --config');
    const options = readJson(process.argv[3]);
    const root = path.resolve(options.root);
    const mysqlRoot = path.join(root, 'mysql');
    const dataDir = path.join(mysqlRoot, 'data');
    const stateFile = path.join(mysqlRoot, 'runtime.json');
    const databaseConfigFile = path.join(root, 'data', 'database-config.json');
    const logFile = path.join(root, 'logs', 'mysql-server.log');
    if (!fs.existsSync(path.join(options.runtimeDir, 'bin', 'mysqld.exe'))) throw new Error('安装包缺少 MySQL 运行文件');
    const existingConfig = fs.existsSync(databaseConfigFile) ? readJson(databaseConfigFile) : null;
    if (existingConfig && existingConfig.managedBy !== 'desktop-mysql') throw new Error('已有数据库配置不属于随包 MySQL，拒绝覆盖');
    let state;
    if (fs.existsSync(stateFile)) {
        state = readJson(stateFile);
        if (state.version !== 1 || !state.rootPassword || !state.password || !state.instanceId) throw new Error('随包 MySQL 状态文件不完整，请从备份恢复，不能覆盖现有数据');
        if (existingConfig && existingConfig.instanceId !== state.instanceId) throw new Error('MySQL 实例标识与已有配置不匹配');
    } else {
        if (existingConfig || (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length)) throw new Error('检测到未归属本程序的 MySQL 数据，拒绝重新初始化');
        state = { version: 1, instanceId: crypto.randomUUID(), rootPassword: crypto.randomBytes(32).toString('hex'),
            password: crypto.randomBytes(32).toString('hex'), user: 'digital_twin', database: 'digital_twin', initialized: false, secured: false };
        atomicJson(stateFile, state);
    }
    const nativePaths = mysqlAsciiPaths(mysqlRoot, options.runtimeDir);
    const executable = path.join(nativePaths.runtime, 'bin', 'mysqld.exe');
    const nativeDataDir = path.join(nativePaths.storage, 'data');
    if (!state.initialized) {
        progress('首次运行：正在初始化随包 MySQL 数据文件');
        // A cancelled initialization has never contained application data. Keep
        // the partial directory for diagnosis and retry in a new empty directory.
        if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
            fs.renameSync(dataDir, path.join(mysqlRoot, `initialization-incomplete-${Date.now()}`));
        }
        fs.mkdirSync(dataDir, { recursive: true });
        launch(executable, ['--no-defaults', '--initialize-insecure', `--basedir=${nativePaths.runtime}`, `--datadir=${nativeDataDir}`, '--console'], logFile);
        const initialized = await serverExit;
        checkRunning();
        if (initialized.code !== 0) throw new Error('MySQL 初始化失败，请查看 mysql-server.log');
        state.initialized = true;
        atomicJson(stateFile, state);
    }
    checkRunning();
    state.port = await freePort(state.port);
    atomicJson(stateFile, state);
    progress('正在启动随包 MySQL 本机数据库');
    launch(executable, ['--no-defaults', `--basedir=${nativePaths.runtime}`, `--datadir=${nativeDataDir}`,
        '--bind-address=127.0.0.1', `--port=${state.port}`, '--mysqlx=0', '--max-allowed-packet=64M',
        '--innodb-buffer-pool-size=128M', '--sort-buffer-size=16M', '--skip-log-bin', `--pid-file=${path.join(nativePaths.storage, 'mysqld.pid')}`, '--console'], logFile);
    credentials = { host: '127.0.0.1', port: state.port, user: 'root', password: state.rootPassword };
    let admin;
    for (let attempt = 0; attempt < 150; attempt++) {
        checkRunning();
        if (server.exitCode !== null || server.signalCode !== null) throw new Error('随包 MySQL 启动失败，请查看 mysql-server.log');
        try { admin = await mysql.createConnection({ ...credentials, connectTimeout: 1000 }); break; }
        catch (error) {
            if (!state.secured && error.code === 'ER_ACCESS_DENIED_ERROR') {
                try { admin = await mysql.createConnection({ ...credentials, password: '', connectTimeout: 1000 }); break; } catch { /* still starting */ }
            }
            await sleep(200);
        }
    }
    if (!admin) throw new Error('无法连接本程序的 MySQL 数据库，请查看 mysql-server.log');
    try {
        if (!state.secured) {
            await admin.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [state.rootPassword]);
            state.secured = true;
            atomicJson(stateFile, state);
        }
        checkRunning();
        progress('正在核对并导入随包工厂配置');
        await seedMysql({ connection: { ...credentials, database: state.database },
            sourcePath: options.templateFile, markerPath: path.join(mysqlRoot, 'seed-complete.json') });
        checkRunning();
        await admin.query("CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?", [state.user, state.password]);
        // Reapplying the same generated secret repairs a crash between account
        // creation and publication of database-config.json.
        await admin.query("ALTER USER ?@'localhost' IDENTIFIED BY ?", [state.user, state.password]);
        await admin.query(`GRANT ALL PRIVILEGES ON ${quote(state.database)}.* TO ?@'localhost'`, [state.user]);
        const config = { type: 'mysql', host: '127.0.0.1', port: state.port, user: state.user, password: state.password,
            database: state.database, filename: path.join(root, 'data', 'factory.db'), managedBy: 'desktop-mysql', instanceId: state.instanceId };
        atomicJson(databaseConfigFile, { ...existingConfig, ...config });
        progress('随包 MySQL 已就绪');
        send({ type: 'ready', config: { type: config.type, host: config.host, port: config.port, database: config.database } });
    } finally { await admin.end(); }
    serverExit.then(async () => {
        if (!stopping) {
            send({ type: 'error', message: '随包 MySQL 意外退出，请重新启动软件并查看 mysql-server.log' });
            process.exitCode = 1;
            process.disconnect?.();
        }
    });
}

process.on('message', message => {
    if (message.type === 'shutdown') shutdown().finally(() => process.exit(0));
});
process.on('disconnect', () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
main().catch(async error => {
    console.error(error.stack || String(error));
    send({ type: 'error', message: error.message });
    await shutdown();
    process.exit(1);
});
