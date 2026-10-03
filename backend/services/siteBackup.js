const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const unzipper = require('unzipper');
const {
    GiB, resolveBackupBudget, exists, listFiles, hashingTransform,
    copyAndHash, ensureDiskSpace, shouldStore
} = require('../utils/backupStorage');
const {
    createDatabaseBackup,
    importDatabaseBackupFile,
    restoreDatabaseBackup,
    resolveDatabaseBackupPath,
    getDatabaseBackupStatus,
    getDatabaseBackupSpaceEstimate,
    verifyDatabaseBackupFile,
    verifySqliteFile,
    loadDatabaseConfig
} = require('../db/database');
const { reloadDataSourceConfiguration } = require('./dataSources');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const SITE_BACKUP_DIR = path.resolve(process.env.SITE_BACKUP_DIR || path.join(DATA_DIR, 'site-backups'));
const SITE_IMPORT_DIR = path.resolve(process.env.SITE_IMPORT_DIR || path.join(DATA_DIR, 'site-imports'));
const SITE_BACKUP_CONFIG_PATH = path.join(DATA_DIR, 'site-backup-config.json');
const SITE_BACKUP_RETENTION = positiveInteger(process.env.SITE_BACKUP_RETENTION, 5);
const SITE_BACKUP_STORAGE_POLICY = resolveBackupBudget({
    dataDir: DATA_DIR, directory: SITE_BACKUP_DIR, kind: 'site',
    envValue: process.env.SITE_BACKUP_MAX_TOTAL_BYTES, defaultBytes: 4 * GiB,
    matches: name => isManagedSiteBackup(name)
});
const SITE_BACKUP_MAX_TOTAL_BYTES = SITE_BACKUP_STORAGE_POLICY.maxTotalBytes;
const SITE_BACKUP_MIN_FREE_BYTES = positiveInteger(process.env.SITE_BACKUP_MIN_FREE_BYTES, 512 * 1024 * 1024);
const SITE_BACKUP_MIRROR_RETENTION = positiveInteger(process.env.SITE_BACKUP_MIRROR_RETENTION, 30);
const SITE_BACKUP_FORMAT = 'heat-treatment-digital-twin-site-backup';
const SITE_BACKUP_VERSION = 3;
const UPLOAD_GROUPS = ['models', 'audio', 'appearance', 'projects'];
const LEGACY_DATA_SOURCE_CONFIG = 'data-sources.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10000;
const MAX_ARCHIVE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_BYTES = 2 * 1024 * 1024 * 1024;
let activeSiteBackupOperation = null;
let siteBackupTimer = null;
let siteBackupInitialTimer = null;
let maintenanceUploadsRootDir = null;
let lastAutomaticBackup = null;
let lastSiteBackupError = null;
let lastMirrorCopy = null;

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function describeConfigFile(filename) {
    const name = String(filename || '');
    if (name === LEGACY_DATA_SOURCE_CONFIG
        || /^data-sources\.[a-zA-Z0-9_-]{1,128}\.json$/.test(name)) {
        return { filename: name, archivePath: `config/${name}`, sensitive: true };
    }
    return null;
}

function describeConfigArchivePath(archivePath) {
    const normalized = String(archivePath || '');
    if (!normalized.startsWith('config/')) return null;
    const descriptor = describeConfigFile(normalized.slice('config/'.length));
    return descriptor?.archivePath === normalized ? descriptor : null;
}

function listAvailableConfigFiles() {
    let names = [LEGACY_DATA_SOURCE_CONFIG];
    try {
        names = [...names, ...fs.readdirSync(DATA_DIR).filter(name => /^data-sources\.[a-zA-Z0-9_-]{1,128}\.json$/.test(name))];
    } catch { /* A fresh install may not have created its data directory yet. */ }
    return [...new Set(names)].map(describeConfigFile).filter(Boolean);
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function loadSiteBackupConfig() {
    let stored = {};
    try {
        if (fs.existsSync(SITE_BACKUP_CONFIG_PATH)) stored = JSON.parse(fs.readFileSync(SITE_BACKUP_CONFIG_PATH, 'utf8'));
    } catch (error) {
        lastSiteBackupError = { at: new Date().toISOString(), operation: '读取灾备配置', error: error.message };
    }
    const configuredMirror = String(stored.mirrorDirectory || process.env.SITE_BACKUP_MIRROR_DIR || '').trim();
    return {
        autoEnabled: stored.autoEnabled !== undefined
            ? stored.autoEnabled !== false
            : process.env.SITE_BACKUP_AUTO_ENABLED !== 'false',
        intervalHours: clampNumber(
            stored.intervalHours ?? process.env.SITE_BACKUP_INTERVAL_HOURS,
            1,
            168,
            24
        ),
        mirrorDirectory: configuredMirror ? path.resolve(configuredMirror) : ''
    };
}

function saveSiteBackupConfig(input = {}) {
    ensureDirectory(DATA_DIR);
    const config = {
        autoEnabled: input.autoEnabled !== false,
        intervalHours: clampNumber(input.intervalHours, 1, 168, 24),
        mirrorDirectory: String(input.mirrorDirectory || '').trim()
            ? path.resolve(String(input.mirrorDirectory).trim())
            : ''
    };
    const temporary = `${SITE_BACKUP_CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(temporary, SITE_BACKUP_CONFIG_PATH);
    return config;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function sha256File(filename) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filename);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function isManagedSiteBackup(filename) {
    return /^heat-treatment-site-backup-\d{8}T\d{9}Z\.zip$/i.test(String(filename || ''));
}

async function managedBackupFiles(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.filter(item => item.isFile() && isManagedSiteBackup(item.name))) {
        const filename = path.join(directory, entry.name);
        files.push({ filename, stat: await fs.promises.stat(filename) });
    }
    return files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function pruneMirrorBackups(directory, protectedFilename) {
    const files = await managedBackupFiles(directory);
    for (const item of files.slice(SITE_BACKUP_MIRROR_RETENTION)) {
        if (item.filename !== protectedFilename) await fs.promises.rm(item.filename, { force: true });
    }
}

function validateMirrorDirectory(mirrorDirectory) {
    const targetRoot = path.resolve(mirrorDirectory);
    const localRoot = path.resolve(SITE_BACKUP_DIR);
    const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (compare(targetRoot) === compare(localRoot) || compare(targetRoot).startsWith(`${compare(localRoot)}${path.sep}`)) {
        throw new Error('异地灾备目录不能位于软件本机灾备目录内部');
    }
    return targetRoot;
}

async function mirrorSiteBackup(filename, mirrorDirectory, expectedSha256) {
    const targetRoot = validateMirrorDirectory(mirrorDirectory);
    const sourceSize = (await fs.promises.stat(filename)).size;
    await ensureDiskSpace([{ directory: targetRoot, bytes: sourceSize }], SITE_BACKUP_MIN_FREE_BYTES);
    await fs.promises.mkdir(targetRoot, { recursive: true });
    const destination = path.join(targetRoot, path.basename(filename));
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.promises.rm(temporary, { force: true });
    try {
        const copied = await copyAndHash(filename, temporary, sourceSize);
        const sourceHash = copied.sha256;
        if (expectedSha256 && sourceHash !== expectedSha256) throw new Error('本机灾备文件哈希校验失败');
        const copiedHash = await sha256File(temporary);
        if (sourceHash !== copiedHash) throw new Error('异地灾备副本哈希校验失败');
        await fs.promises.rename(temporary, destination);
        await pruneMirrorBackups(targetRoot, destination);
        lastMirrorCopy = {
            at: new Date().toISOString(),
            directory: targetRoot,
            filename: path.basename(destination),
            sha256: sourceHash
        };
        return lastMirrorCopy;
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}

function backupDescriptor(filename) {
    const stat = fs.statSync(filename);
    return {
        filename: path.basename(filename),
        size: stat.size,
        createdAt: stat.mtime.toISOString()
    };
}

function listSiteBackups() {
    ensureDirectory(SITE_BACKUP_DIR);
    return fs.readdirSync(SITE_BACKUP_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
        .map(entry => path.join(SITE_BACKUP_DIR, entry.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        .map(backupDescriptor);
}

async function pruneSiteBackups(protectedFilename) {
    const files = await managedBackupFiles(SITE_BACKUP_DIR);
    const retained = [];
    for (let index = 0; index < files.length; index++) {
        const item = files[index];
        if (index >= SITE_BACKUP_RETENTION && item.filename !== protectedFilename) {
            await fs.promises.rm(item.filename, { force: true });
        } else retained.push(item);
    }
    let totalBytes = retained.reduce((sum, backup) => sum + backup.stat.size, 0);
    for (const backup of retained.slice(1).reverse()) {
        if (totalBytes <= SITE_BACKUP_MAX_TOTAL_BYTES) break;
        if (backup.filename === protectedFilename) continue;
        await fs.promises.rm(backup.filename, { force: true });
        totalBytes -= backup.stat.size;
    }
}

function resolveSiteBackupPath(filename) {
    const supplied = String(filename || '');
    const name = path.basename(supplied);
    if (!name || name !== supplied || !name.toLowerCase().endsWith('.zip')) {
        throw new Error('整站备份文件名不合法');
    }
    const resolved = path.join(SITE_BACKUP_DIR, name);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('整站备份文件不存在');
    }
    return resolved;
}

function getSiteBackupStatus() {
    const databaseStatus = getDatabaseBackupStatus({ validate: false });
    const config = loadSiteBackupConfig();
    return {
        supported: databaseStatus.supported,
        databaseType: databaseStatus.type,
        format: SITE_BACKUP_FORMAT,
        version: SITE_BACKUP_VERSION,
        retention: SITE_BACKUP_RETENTION,
        maxTotalBytes: SITE_BACKUP_MAX_TOTAL_BYTES,
        storagePolicy: SITE_BACKUP_STORAGE_POLICY,
        minFreeBytes: SITE_BACKUP_MIN_FREE_BYTES,
        localDirectory: SITE_BACKUP_DIR,
        externalCopyRequired: true,
        config,
        lastAutomaticBackup,
        lastError: lastSiteBackupError,
        lastMirrorCopy,
        mirrorConfigured: Boolean(config.mirrorDirectory),
        toolError: databaseStatus.toolError || null,
        busy: activeSiteBackupOperation?.name || null,
        backups: databaseStatus.supported ? listSiteBackups() : []
    };
}

async function runSiteBackupOperation(name, callback) {
    if (activeSiteBackupOperation) {
        throw new Error(`整站灾备正在${activeSiteBackupOperation.name}，请稍后再试`);
    }
    const operation = { name };
    activeSiteBackupOperation = operation;
    try {
        operation.promise = Promise.resolve().then(callback);
        return await operation.promise;
    } finally {
        if (activeSiteBackupOperation === operation) activeSiteBackupOperation = null;
    }
}

async function createSiteBackup(uploadsRootDir) {
    return runSiteBackupOperation('导出', () => createSiteBackupUnlocked(uploadsRootDir));
}

async function createSiteBackupUnlocked(uploadsRootDir) {
    const databaseStatus = getDatabaseBackupStatus({ validate: false });
    if (!databaseStatus.supported) {
        throw new Error(databaseStatus.toolError || '当前数据库不支持整站灾备导出');
    }
    const databaseType = String(loadDatabaseConfig().type || '').toLowerCase();
    const databaseArchivePath = databaseType === 'mysql'
        ? 'database/mysql.sql.gz'
        : 'database/factory.db';
    const uploadsRoot = path.resolve(uploadsRootDir);
    const sources = [];
    for (const group of UPLOAD_GROUPS) {
        for (const source of await listFiles(path.join(uploadsRoot, group))) {
            const relative = path.relative(uploadsRoot, source.filename).split(path.sep).join('/');
            sources.push({ ...source, archivePath: `uploads/${relative}`, relative });
        }
    }
    let configNames = [];
    try { configNames = await fs.promises.readdir(DATA_DIR); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of configNames) {
        const descriptor = describeConfigFile(name);
        if (!descriptor) continue;
        const filename = path.join(DATA_DIR, name);
        const stat = await fs.promises.lstat(filename);
        if (stat.isFile()) sources.push({ ...descriptor, filename, size: stat.size });
    }
    const config = loadSiteBackupConfig();
    if (config.mirrorDirectory) validateMirrorDirectory(config.mirrorDirectory);
    const sourceBytes = sources.reduce((sum, file) => sum + file.size, 0);
    const portablePaths = new Set();
    for (const source of sources) {
        const portablePath = normalizeArchivePath(source.archivePath).toLowerCase();
        if (portablePaths.has(portablePath)) throw new Error(`整站备份包含重复文件: ${source.archivePath}`);
        portablePaths.add(portablePath);
        if (source.size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`整站备份文件超过安全限制: ${source.archivePath}`);
    }
    if (sourceBytes > MAX_ARCHIVE_CONTENT_BYTES || sources.length + 2 > MAX_ARCHIVE_ENTRIES) {
        throw new Error('整站备份内容超过安全限制');
    }
    const databaseEstimate = await getDatabaseBackupSpaceEstimate();
    const zipAllowance = bytes => Math.ceil(bytes * 1.02) + MAX_MANIFEST_BYTES + (sources.length + 2) * 1024;
    async function reserveSpace(databaseBytes, includeDump) {
        const requests = [
            { directory: SITE_IMPORT_DIR, bytes: sourceBytes + databaseBytes },
            { directory: SITE_BACKUP_DIR, bytes: zipAllowance(sourceBytes + databaseBytes) }
        ];
        if (includeDump) requests.push({ directory: process.env.DB_BACKUP_DIR || path.join(DATA_DIR, 'backups'), bytes: databaseBytes });
        if (config.mirrorDirectory) requests.push({ directory: config.mirrorDirectory, bytes: zipAllowance(sourceBytes + databaseBytes) });
        await ensureDiskSpace(requests, SITE_BACKUP_MIN_FREE_BYTES);
    }
    // Reject before generating any new dump/staging/.tmp; never delete old
    // backups to make room. Account for all coexisting temporary files.
    await reserveSpace(databaseEstimate, true);
    const databaseBackup = await createDatabaseBackup('site-export');
    const databaseFilename = resolveDatabaseBackupPath(databaseBackup.filename);
    const databaseSize = (await fs.promises.stat(databaseFilename)).size;
    await reserveSpace(databaseSize, false);
    await fs.promises.mkdir(SITE_BACKUP_DIR, { recursive: true });
    await fs.promises.mkdir(SITE_IMPORT_DIR, { recursive: true });
    const exportStaging = path.join(SITE_IMPORT_DIR, `export-${timestampToken()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    let temporary = null;

    try {
        const manifestFiles = [];
        const snapshotFiles = [];
        for (const source of [{ filename: databaseFilename, archivePath: databaseArchivePath, size: databaseSize }, ...sources]) {
            normalizeArchivePath(source.archivePath);
            const filename = path.join(exportStaging, ...source.archivePath.split('/'));
            const copied = await copyAndHash(source.filename, filename, source.size);
            manifestFiles.push({ path: source.archivePath, ...copied });
            snapshotFiles.push({ ...source, filename });
        }
        const uploadedFiles = snapshotFiles.filter(file => file.relative);
        const configFiles = snapshotFiles.filter(file => file.sensitive);

        const createdAt = new Date();
        const manifest = {
            format: SITE_BACKUP_FORMAT,
            version: SITE_BACKUP_VERSION,
            createdAt: createdAt.toISOString(),
            databaseType,
            databasePath: databaseArchivePath,
            uploadGroups: UPLOAD_GROUPS,
            uploadedFileCount: uploadedFiles.length,
            configFiles: configFiles.map(file => file.archivePath),
            containsSensitiveConfiguration: configFiles.some(file => file.sensitive),
            files: manifestFiles
        };
        const filename = `heat-treatment-site-backup-${timestampToken(createdAt)}.zip`;
        const destination = path.join(SITE_BACKUP_DIR, filename);
        temporary = `${destination}.${process.pid}.tmp`;
        // Never publish a package the restore safety limits would reject.
        validateManifest(manifest);
        const manifestJson = JSON.stringify(manifest, null, 2);
        if (Buffer.byteLength(manifestJson) > MAX_MANIFEST_BYTES || snapshotFiles.length + 1 > MAX_ARCHIVE_ENTRIES) {
            throw new Error('整站备份清单超过安全限制');
        }
        const archive = archiver('zip', { zlib: { level: 6 } });
        const archiveHasher = hashingTransform();
        archive.on('warning', error => archive.destroy(error));
        const writing = pipeline(archive, archiveHasher.stream, fs.createWriteStream(temporary, { flags: 'wx' }));
        // Observe the write failure immediately while finalization is pending.
        writing.catch(() => {});
        for (const file of snapshotFiles) {
            archive.file(file.filename, { name: file.archivePath, store: shouldStore(file.archivePath) });
        }
        archive.append(manifestJson, { name: 'manifest.json' });
        try {
            await Promise.all([archive.finalize(), writing]);
        } catch (error) {
            archive.destroy(error);
            await writing.catch(() => {});
            throw error;
        }
        const archiveResult = archiveHasher.result();
        await fs.promises.rename(temporary, destination);
        await pruneSiteBackups(destination);
        const backup = {
            ...backupDescriptor(destination),
            sha256: archiveResult.sha256,
            uploadedFileCount: uploadedFiles.length,
            manifestCreatedAt: manifest.createdAt
        };
        if (config.mirrorDirectory) {
            try {
                backup.mirror = await mirrorSiteBackup(destination, config.mirrorDirectory, backup.sha256);
                lastSiteBackupError = null;
            } catch (error) {
                lastSiteBackupError = { at: new Date().toISOString(), operation: '异地复制', error: error.message };
                // 本机包仍然可用，但明确把异地失败返回给运维界面。
                backup.mirrorError = error.message;
            }
        }
        return backup;
    } finally {
        if (temporary) await fs.promises.rm(temporary, { force: true });
        await fs.promises.rm(exportStaging, { recursive: true, force: true });
    }
}

function normalizeArchivePath(value) {
    const supplied = String(value || '');
    if (!supplied || supplied.includes('\\') || path.posix.isAbsolute(supplied)) {
        throw new Error('备份包包含不合法的文件路径');
    }
    const normalized = path.posix.normalize(supplied);
    if (normalized !== supplied || normalized === '..' || normalized.startsWith('../')) {
        throw new Error('备份包包含越界文件路径');
    }
    // Backups are portable to Windows: reject device names, alternate data
    // streams, and aliases such as "file." before any extraction takes place.
    if (normalized.split('/').some(segment => /[<>:"|?*\x00-\x1f]/.test(segment)
        || /[. ]$/.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) {
        throw new Error('备份包包含不安全的文件路径');
    }
    return normalized;
}

function validateManifest(manifest) {
    if (!manifest || manifest.format !== SITE_BACKUP_FORMAT || ![1, 2, SITE_BACKUP_VERSION].includes(Number(manifest.version))) {
        throw new Error('不是受支持的整站备份包');
    }
    if (!['sqlite', 'mysql'].includes(String(manifest.databaseType || '').toLowerCase()) || !Array.isArray(manifest.files)) {
        throw new Error('整站备份清单不完整');
    }
    const databaseType = String(manifest.databaseType).toLowerCase();
    const databasePath = String(manifest.databasePath || (databaseType === 'mysql' ? 'database/mysql.sql.gz' : 'database/factory.db'));
    const expectedDatabasePath = databaseType === 'mysql' ? 'database/mysql.sql.gz' : 'database/factory.db';
    if (databasePath !== expectedDatabasePath) throw new Error('整站备份数据库文件路径不合法');
    if (manifest.uploadGroups !== undefined) {
        if (!Array.isArray(manifest.uploadGroups)
            || manifest.uploadGroups.some(group => !UPLOAD_GROUPS.includes(String(group)))) {
            throw new Error('整站备份上传目录清单不合法');
        }
    }
    if (manifest.configFiles !== undefined) {
        if (!Array.isArray(manifest.configFiles)
            || manifest.configFiles.some(configPath => !describeConfigArchivePath(configPath))) {
            throw new Error('整站备份配置文件清单不合法');
        }
    }
    const declared = new Map();
    const portablePaths = new Set();
    let totalSize = 0;
    for (const file of manifest.files) {
        const archivePath = normalizeArchivePath(file?.path);
        const size = Number(file?.size);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        const portablePath = archivePath.toLowerCase();
        if (portablePaths.has(portablePath)) throw new Error(`整站备份清单存在重复文件: ${archivePath}`);
        portablePaths.add(portablePath);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_FILE_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
            throw new Error(`整站备份文件校验信息无效: ${archivePath}`);
        }
        if (archivePath !== databasePath
            && !UPLOAD_GROUPS.some(group => archivePath.startsWith(`uploads/${group}/`))
            && !describeConfigArchivePath(archivePath)) {
            throw new Error(`整站备份包含不允许恢复的文件: ${archivePath}`);
        }
        totalSize += size;
        if (totalSize > MAX_ARCHIVE_CONTENT_BYTES) throw new Error('整站备份解压后体积超过安全限制');
        declared.set(archivePath, { path: archivePath, size, sha256 });
    }
    if (!declared.has(databasePath)) throw new Error('整站备份缺少数据库文件');
    const configPaths = [...declared.keys()].filter(archivePath => describeConfigArchivePath(archivePath));
    return { declared, databaseType, databasePath, configPaths };
}

async function extractValidatedArchive(archiveFilename, stagingDirectory, reserveSpace) {
    const directory = await unzipper.Open.file(archiveFilename);
    const entries = directory.files.filter(entry => entry.type === 'File');
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('整站备份文件数量超过安全限制');
    const entryMap = new Map();
    const portablePaths = new Set();
    for (const entry of entries) {
        const archivePath = normalizeArchivePath(entry.path);
        const portablePath = archivePath.toLowerCase();
        if (portablePaths.has(portablePath)) throw new Error(`整站备份包含重复文件: ${archivePath}`);
        portablePaths.add(portablePath);
        entryMap.set(archivePath, entry);
    }

    const manifestEntry = entryMap.get('manifest.json');
    if (!manifestEntry || Number(manifestEntry.uncompressedSize || 0) > MAX_MANIFEST_BYTES) {
        throw new Error('整站备份缺少有效清单');
    }
    const manifest = JSON.parse((await readEntryBuffer(manifestEntry, MAX_MANIFEST_BYTES)).toString('utf8'));
    const { declared, databaseType, databasePath, configPaths } = validateManifest(manifest);
    if (reserveSpace) await reserveSpace({ declared, configPaths });

    for (const archivePath of entryMap.keys()) {
        if (archivePath !== 'manifest.json' && !declared.has(archivePath)) {
            throw new Error(`整站备份包含未登记文件: ${archivePath}`);
        }
    }
    for (const file of declared.values()) {
        const entry = entryMap.get(file.path);
        if (!entry) throw new Error(`整站备份缺少文件: ${file.path}`);
        const declaredEntrySize = Number(entry.uncompressedSize ?? entry.size);
        if (Number.isFinite(declaredEntrySize) && declaredEntrySize !== file.size) {
            throw new Error(`整站备份文件大小校验失败: ${file.path}`);
        }
        const destination = path.join(stagingDirectory, ...file.path.split('/'));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await streamEntryToFile(entry, destination, file.size, file.sha256);
    }

    const databaseFilename = path.join(stagingDirectory, ...databasePath.split('/'));
    const activeDatabaseType = String(loadDatabaseConfig().type || '').toLowerCase();
    if (activeDatabaseType !== databaseType) {
        throw new Error(`灾备包数据库类型为 ${databaseType}，当前现场配置为 ${activeDatabaseType}，请先切换数据库类型`);
    }
    const verification = databaseType === 'sqlite'
        ? verifySqliteFile(databaseFilename, { requireApplicationSchema: true })
        : await verifyDatabaseBackupFile(databaseFilename);
    if (!verification.valid) throw new Error(`整站备份数据库校验失败: ${verification.error}`);
    return { manifest, databaseFilename, configPaths };
}

async function readEntryBuffer(entry, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of entry.stream()) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('整站备份清单超过安全限制');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

async function streamEntryToFile(entry, destination, expectedSize, expectedSha256) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const verifier = new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > expectedSize) {
                callback(new Error(`整站备份文件超过清单大小: ${destination}`));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        },
        flush(callback) {
            if (bytes !== expectedSize) {
                callback(new Error(`整站备份文件大小校验失败: ${destination}`));
                return;
            }
            callback();
        }
    });
    try {
        await pipeline(entry.stream(), verifier, fs.createWriteStream(destination));
        if (hash.digest('hex') !== expectedSha256) throw new Error(`整站备份文件校验失败: ${destination}`);
    } catch (error) {
        await fs.promises.rm(destination, { force: true });
        throw error;
    }
}

async function restoreSiteBackup(archiveFilename, uploadsRootDir) {
    return runSiteBackupOperation('恢复', () => restoreSiteBackupUnlocked(archiveFilename, uploadsRootDir));
}

async function restoreSiteBackupUnlocked(archiveFilename, uploadsRootDir) {
    if (!getSiteBackupStatus().supported) {
        throw new Error(getSiteBackupStatus().toolError || '当前数据库不支持整站灾备恢复');
    }

    await fs.promises.mkdir(SITE_IMPORT_DIR, { recursive: true });
    const stagingDirectory = path.join(SITE_IMPORT_DIR, `restore-${timestampToken()}-${process.pid}`);
    const uploadsRoot = path.resolve(uploadsRootDir);
    const rollbackUploads = path.join(stagingDirectory, 'rollback-uploads');
    const rollbackConfig = path.join(stagingDirectory, 'rollback-config');
    let uploadsMutationStarted = false;
    let configMutationStarted = false;
    let uploadGroupsToRestore = ['models'];
    let configPathsToRestore = [];
    let preserveStaging = false;
    await fs.promises.mkdir(stagingDirectory, { recursive: true });

    try {
        const { manifest, databaseFilename, configPaths } = await extractValidatedArchive(path.resolve(archiveFilename), stagingDirectory, async ({ declared, configPaths }) => {
            let rollbackBytes = 0;
            for (const group of UPLOAD_GROUPS) {
                rollbackBytes += (await listFiles(path.join(uploadsRoot, group))).reduce((sum, file) => sum + file.size, 0);
            }
            for (const archivePath of configPaths) {
                const current = path.join(DATA_DIR, describeConfigArchivePath(archivePath).filename);
                if (await exists(current)) rollbackBytes += (await fs.promises.stat(current)).size;
            }
            const files = [...declared.values()];
            const extractedBytes = files.reduce((sum, file) => sum + file.size, 0);
            const databaseBytes = files.filter(file => file.path.startsWith('database/')).reduce((sum, file) => sum + file.size, 0);
            await ensureDiskSpace([
                { directory: SITE_IMPORT_DIR, bytes: extractedBytes + rollbackBytes },
                { directory: uploadsRoot, bytes: files.filter(file => file.path.startsWith('uploads/')).reduce((sum, file) => sum + file.size, 0) },
                { directory: DATA_DIR, bytes: databaseBytes + await getDatabaseBackupSpaceEstimate() },
                { directory: process.env.DB_BACKUP_DIR || path.join(DATA_DIR, 'backups'), bytes: databaseBytes + await getDatabaseBackupSpaceEstimate() }
            ], SITE_BACKUP_MIN_FREE_BYTES);
        });
        uploadGroupsToRestore = Array.isArray(manifest.uploadGroups)
            ? [...new Set(manifest.uploadGroups.filter(group => UPLOAD_GROUPS.includes(group)))]
            : ['models'];
        configPathsToRestore = configPaths || [];
        for (const group of uploadGroupsToRestore) {
            const currentDirectory = path.join(uploadsRoot, group);
            const rollbackDirectory = path.join(rollbackUploads, group);
            if (await exists(currentDirectory)) await fs.promises.cp(currentDirectory, rollbackDirectory, { recursive: true });
        }

        uploadsMutationStarted = true;
        for (const group of uploadGroupsToRestore) {
            const currentDirectory = path.join(uploadsRoot, group);
            const restoredDirectory = path.join(stagingDirectory, 'uploads', group);
            await fs.promises.rm(currentDirectory, { recursive: true, force: true });
            if (await exists(restoredDirectory)) await fs.promises.cp(restoredDirectory, currentDirectory, { recursive: true });
            await fs.promises.mkdir(currentDirectory, { recursive: true });
        }

        for (const archivePath of configPathsToRestore) {
            const descriptor = describeConfigArchivePath(archivePath);
            if (!descriptor) continue;
            const currentFilename = path.join(DATA_DIR, descriptor.filename);
            const rollbackFilename = path.join(rollbackConfig, descriptor.filename);
            if (await exists(currentFilename)) {
                await fs.promises.mkdir(path.dirname(rollbackFilename), { recursive: true });
                await fs.promises.copyFile(currentFilename, rollbackFilename);
            }
        }
        configMutationStarted = configPathsToRestore.length > 0;
        for (const archivePath of configPathsToRestore) {
            const descriptor = describeConfigArchivePath(archivePath);
            if (!descriptor) continue;
            const restoredFilename = path.join(stagingDirectory, ...archivePath.split('/'));
            const parsed = JSON.parse(await fs.promises.readFile(restoredFilename, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) {
                throw new Error(`整站备份中的配置文件无效：${descriptor.filename}`);
            }
            const currentFilename = path.join(DATA_DIR, descriptor.filename);
            await fs.promises.mkdir(path.dirname(currentFilename), { recursive: true });
            const temporary = `${currentFilename}.${process.pid}.restore.tmp`;
            await fs.promises.rm(temporary, { force: true });
            try {
                await fs.promises.copyFile(restoredFilename, temporary);
                await fs.promises.rename(temporary, currentFilename);
            } finally {
                await fs.promises.rm(temporary, { force: true });
            }
        }
        if (configMutationStarted) reloadDataSourceConfiguration();

        const imported = await importDatabaseBackupFile(databaseFilename, 'site-import');
        const databaseRestore = await restoreDatabaseBackup(imported.filename);
        return {
            success: true,
            manifestCreatedAt: manifest.createdAt,
            uploadedFileCount: manifest.uploadedFileCount || 0,
            databaseBackup: imported,
            rollback: databaseRestore.rollback,
            recovery: databaseRestore.recovery
        };
    } catch (error) {
        const rollbackErrors = [];
        if (configMutationStarted) {
            for (const archivePath of configPathsToRestore) {
                const descriptor = describeConfigArchivePath(archivePath);
                if (!descriptor) continue;
                const currentFilename = path.join(DATA_DIR, descriptor.filename);
                const rollbackFilename = path.join(rollbackConfig, descriptor.filename);
                try {
                    await fs.promises.rm(currentFilename, { force: true });
                    if (await exists(rollbackFilename)) await fs.promises.copyFile(rollbackFilename, currentFilename);
                } catch (rollbackError) {
                    rollbackErrors.push(`${descriptor.filename}: ${rollbackError.message}`);
                }
            }
            try { reloadDataSourceConfiguration(); } catch (rollbackError) {
                rollbackErrors.push(`数据源配置: ${rollbackError.message}`);
            }
        }
        if (uploadsMutationStarted) {
            for (const group of uploadGroupsToRestore) {
                const currentDirectory = path.join(uploadsRoot, group);
                const rollbackDirectory = path.join(rollbackUploads, group);
                try {
                    await fs.promises.rm(currentDirectory, { recursive: true, force: true });
                    if (await exists(rollbackDirectory)) await fs.promises.cp(rollbackDirectory, currentDirectory, { recursive: true });
                    await fs.promises.mkdir(currentDirectory, { recursive: true });
                } catch (rollbackError) {
                    rollbackErrors.push(`${group}: ${rollbackError.message}`);
                }
            }
        }
        if (rollbackErrors.length) {
            preserveStaging = true;
            throw new Error(`${error.message}；自动回滚未完成：${rollbackErrors.join('；')}。原始文件保留于 ${stagingDirectory}`);
        }
        throw error;
    } finally {
        if (!preserveStaging) await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    }
}

async function runAutomaticSiteBackup() {
    if (!maintenanceUploadsRootDir) return null;
    const config = loadSiteBackupConfig();
    if (!config.autoEnabled) return null;
    try {
        const backup = await createSiteBackup(maintenanceUploadsRootDir);
        lastAutomaticBackup = {
            at: new Date().toISOString(),
            filename: backup.filename,
            mirror: backup.mirror || null,
            mirrorError: backup.mirrorError || null
        };
        if (backup.mirrorError) {
            lastSiteBackupError = { at: new Date().toISOString(), operation: '异地复制', error: backup.mirrorError };
        } else {
            lastSiteBackupError = null;
        }
        return backup;
    } catch (error) {
        lastSiteBackupError = { at: new Date().toISOString(), operation: '自动整站备份', error: error.message };
        throw error;
    }
}

async function startSiteBackupMaintenance(uploadsRootDir) {
    maintenanceUploadsRootDir = path.resolve(uploadsRootDir);
    if (siteBackupTimer) clearInterval(siteBackupTimer);
    if (siteBackupInitialTimer) clearTimeout(siteBackupInitialTimer);
    siteBackupTimer = null;
    siteBackupInitialTimer = null;
    const config = loadSiteBackupConfig();
    if (!config.autoEnabled || process.env.NODE_ENV === 'test') return getSiteBackupStatus();

    const intervalMs = Math.max(60 * 60 * 1000, config.intervalHours * 60 * 60 * 1000);
    const latest = listSiteBackups()[0];
    const due = !latest || (Date.now() - new Date(latest.createdAt).getTime() >= intervalMs);
    if (due) {
        // 启动阶段先让数据库/PLC稳定，再在后台生成，不阻塞界面打开。
        siteBackupInitialTimer = setTimeout(() => {
            siteBackupInitialTimer = null;
            runAutomaticSiteBackup().catch(() => {});
        }, 15000);
        siteBackupInitialTimer.unref?.();
    }
    siteBackupTimer = setInterval(() => {
        runAutomaticSiteBackup().catch(() => {});
    }, intervalMs);
    siteBackupTimer.unref?.();
    return getSiteBackupStatus();
}

async function stopSiteBackupMaintenance() {
    if (siteBackupTimer) clearInterval(siteBackupTimer);
    if (siteBackupInitialTimer) clearTimeout(siteBackupInitialTimer);
    siteBackupTimer = null;
    siteBackupInitialTimer = null;
    maintenanceUploadsRootDir = null;
    if (activeSiteBackupOperation?.promise) {
        await activeSiteBackupOperation.promise.catch(() => {});
    }
}

module.exports = {
    createSiteBackup,
    restoreSiteBackup,
    loadSiteBackupConfig,
    saveSiteBackupConfig,
    startSiteBackupMaintenance,
    stopSiteBackupMaintenance,
    getSiteBackupStatus,
    resolveSiteBackupPath,
    SITE_IMPORT_DIR
};
