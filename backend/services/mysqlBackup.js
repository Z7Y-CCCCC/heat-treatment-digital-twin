const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024 * 1024;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function executableName(name) {
    return process.platform === 'win32' ? `${name}.exe` : name;
}

function executableOnPath(name) {
    const filename = executableName(name);
    for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(directory.replace(/^"|"$/g, ''), filename);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function commonToolCandidates(name) {
    const filename = executableName(name);
    const candidates = [];
    const roots = [...new Set([
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
        process.env.ProgramW6432,
        process.platform === 'win32' ? 'C:\\Program Files' : null
    ].filter(Boolean).map(item => path.resolve(item)))];

    for (const root of roots) {
        const mysqlRoot = path.join(root, 'MySQL');
        if (fs.existsSync(mysqlRoot)) {
            for (const entry of fs.readdirSync(mysqlRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const candidate = path.join(mysqlRoot, entry.name, 'bin', filename);
                if (fs.existsSync(candidate)) candidates.push(candidate);
            }
        }
        if (fs.existsSync(root)) {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/^mariadb/i.test(entry.name)) continue;
                const candidate = path.join(root, entry.name, 'bin', filename);
                if (fs.existsSync(candidate)) candidates.push(candidate);
            }
        }
    }
    return candidates;
}

function versionToken(value) {
    const match = String(value || '').match(/(\d+)\.(\d+)/);
    return match ? `${match[1]}.${match[2]}` : '';
}

function chooseCandidate(candidates, preferredVersion) {
    const unique = [...new Set(candidates.map(item => path.resolve(item)))];
    const preferred = versionToken(preferredVersion);
    if (preferred) {
        const exact = unique.find(candidate => versionToken(candidate) === preferred);
        if (exact) return exact;
    }
    return unique.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0] || null;
}

function resolveMysqlTools(preferredVersion = '') {
    const explicitDump = String(process.env.MYSQLDUMP_PATH || '').trim();
    const explicitClient = String(process.env.MYSQL_CLIENT_PATH || '').trim();
    const dumpCandidates = [
        explicitDump && path.resolve(explicitDump),
        executableOnPath('mysqldump'),
        ...commonToolCandidates('mysqldump')
    ].filter(Boolean);
    const clientCandidates = [
        explicitClient && path.resolve(explicitClient),
        executableOnPath('mysql'),
        ...commonToolCandidates('mysql')
    ].filter(Boolean);
    const dump = explicitDump ? path.resolve(explicitDump) : chooseCandidate(dumpCandidates, preferredVersion);
    let client = null;
    if (dump) {
        const sibling = path.join(path.dirname(dump), executableName('mysql'));
        if (fs.existsSync(sibling)) client = sibling;
    }
    client = explicitClient ? path.resolve(explicitClient) : (client || chooseCandidate(clientCandidates, preferredVersion));
    const available = Boolean(dump && client && fs.existsSync(dump) && fs.existsSync(client));
    return {
        available,
        dump,
        client,
        error: available ? null : '未找到 MySQL 客户端工具 mysqldump/mysql；可配置 MYSQLDUMP_PATH 和 MYSQL_CLIENT_PATH'
    };
}

function optionValue(value) {
    return `"${String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')}"`;
}

function createDefaultsFile(config) {
    // 旧版 Windows mysql.exe 无法读取含中文字符的 --defaults-extra-file 路径。
    // 默认放到系统临时目录，并允许现场通过 MYSQL_OPTION_FILE_DIR 指定纯 ASCII 目录。
    const directory = path.resolve(process.env.MYSQL_OPTION_FILE_DIR || os.tmpdir());
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `heat-treatment-mysql-${process.pid}-${crypto.randomBytes(8).toString('hex')}.cnf`);
    const content = [
        '[client]',
        `host=${optionValue(config.host)}`,
        `port=${Number(config.port || 3306)}`,
        `user=${optionValue(config.user)}`,
        `password=${optionValue(config.password)}`,
        'protocol=tcp',
        'default-character-set=utf8mb4',
        ''
    ].join('\n');
    fs.writeFileSync(filename, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return filename;
}

function waitForProcess(child, timeoutMs, operation) {
    return new Promise((resolve, reject) => {
        const errors = [];
        let errorBytes = 0;
        child.stderr?.on('data', chunk => {
            if (errorBytes >= 64 * 1024) return;
            const buffer = Buffer.from(chunk);
            errors.push(buffer.subarray(0, Math.max(0, 64 * 1024 - errorBytes)));
            errorBytes += buffer.length;
        });
        const timer = setTimeout(() => {
            try { child.kill(); } catch (error) { /* ignore */ }
            reject(new Error(`${operation}超时（${Math.round(timeoutMs / 1000)} 秒）`));
        }, timeoutMs);
        timer.unref?.();
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            const detail = Buffer.concat(errors).toString('utf8').trim().replace(/password=[^\s]+/gi, 'password=******');
            reject(new Error(`${operation}失败（代码 ${code ?? 'null'}，信号 ${signal || 'none'}）${detail ? `：${detail}` : ''}`));
        });
    });
}

async function createMysqlDump(config, destination, options = {}) {
    const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.MYSQL_BACKUP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const tools = resolveMysqlTools(options.serverVersion);
    if (!tools.available) throw new Error(tools.error);
    const defaultsFile = createDefaultsFile(config);
    try {
        const childEnvironment = { ...process.env };
        delete childEnvironment.MYSQL_PWD;
        const args = [
            `--defaults-extra-file=${defaultsFile.replace(/\\/g, '/')}`,
            '--single-transaction',
            '--no-tablespaces',
            '--quick',
            '--routines',
            '--events',
            '--triggers',
            '--hex-blob',
            '--skip-lock-tables',
            '--add-drop-table',
            '--set-gtid-purged=OFF',
            String(config.database)
        ];
        const child = spawn(tools.dump, args, {
            argv0: path.basename(tools.dump),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnvironment
        });
        const output = fs.createWriteStream(destination, { flags: 'wx' });
        const processResult = waitForProcess(child, timeoutMs, 'MySQL 备份');
        const streamResult = pipeline(child.stdout, zlib.createGzip({ level: 6 }), output);
        const results = await Promise.allSettled([processResult, streamResult]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        return { tools };
    } finally {
        fs.rmSync(defaultsFile, { force: true });
    }
}

function verifyMysqlDumpFileSync(filename) {
    const resolved = path.resolve(filename);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return { valid: false, error: '文件不存在' };
    const stat = fs.statSync(resolved);
    if (stat.size < 32) return { valid: false, error: 'MySQL 备份文件为空或不完整' };
    const handle = fs.openSync(resolved, 'r');
    try {
        const header = Buffer.alloc(2);
        fs.readSync(handle, header, 0, 2, 0);
        if (header[0] !== 0x1f || header[1] !== 0x8b) return { valid: false, error: 'MySQL 备份不是有效 gzip 文件' };
        return { valid: true, error: null };
    } finally {
        fs.closeSync(handle);
    }
}

async function verifyMysqlDumpFile(filename) {
    const basic = verifyMysqlDumpFileSync(filename);
    if (!basic.valid) return basic;
    const maxBytes = positiveInteger(process.env.MYSQL_BACKUP_MAX_UNCOMPRESSED_BYTES, DEFAULT_MAX_UNCOMPRESSED_BYTES);
    let bytes = 0;
    let markerWindow = '';
    let hasSchemaMarker = false;
    const verifier = new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                callback(new Error('MySQL 备份解压后超过安全体积限制'));
                return;
            }
            markerWindow = `${markerWindow}${chunk.toString('utf8')}`.slice(-256 * 1024);
            if (/CREATE TABLE|INSERT INTO|MySQL dump/i.test(markerWindow)) hasSchemaMarker = true;
            callback();
        }
    });
    try {
        await pipeline(fs.createReadStream(filename), zlib.createGunzip(), verifier);
        if (bytes === 0 || !hasSchemaMarker) throw new Error('MySQL 备份中未发现有效结构或数据');
        return { valid: true, error: null, uncompressedBytes: bytes };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

async function restoreMysqlDump(config, filename, options = {}) {
    const verification = await verifyMysqlDumpFile(filename);
    if (!verification.valid) throw new Error(`MySQL 备份校验失败：${verification.error}`);
    const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.MYSQL_RESTORE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const tools = resolveMysqlTools(options.serverVersion);
    if (!tools.available) throw new Error(tools.error);
    const defaultsFile = createDefaultsFile(config);
    try {
        const childEnvironment = { ...process.env };
        delete childEnvironment.MYSQL_PWD;
        const child = spawn(tools.client, [
            `--defaults-extra-file=${defaultsFile.replace(/\\/g, '/')}`,
            '--binary-mode',
            String(config.database)
        ], {
            argv0: path.basename(tools.client),
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'pipe'],
            env: childEnvironment
        });
        const processResult = waitForProcess(child, timeoutMs, 'MySQL 恢复');
        const streamResult = pipeline(fs.createReadStream(filename), zlib.createGunzip(), child.stdin);
        const results = await Promise.allSettled([processResult, streamResult]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        return { tools, verification };
    } finally {
        fs.rmSync(defaultsFile, { force: true });
    }
}

module.exports = {
    createMysqlDump,
    resolveMysqlTools,
    restoreMysqlDump,
    verifyMysqlDumpFile,
    verifyMysqlDumpFileSync
};
