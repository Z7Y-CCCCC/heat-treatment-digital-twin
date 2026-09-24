const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const unzipper = require('unzipper');
const {
    createDatabaseBackup,
    importDatabaseBackupFile,
    restoreDatabaseBackup,
    resolveDatabaseBackupPath,
    getDatabaseBackupStatus,
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
const SITE_BACKUP_MAX_TOTAL_BYTES = positiveInteger(process.env.SITE_BACKUP_MAX_TOTAL_BYTES, 20 * 1024 * 1024 * 1024);
const SITE_BACKUP_MIRROR_RETENTION = positiveInteger(process.env.SITE_BACKUP_MIRROR_RETENTION, 30);
const SITE_BACKUP_FORMAT = 'heat-treatment-digital-twin-site-backup';
const SITE_BACKUP_VERSION = 3;
const UPLOAD_GROUPS = ['models', 'audio'];
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

function pruneMirrorBackups(directory) {
    if (!fs.existsSync(directory)) return;
    const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && isManagedSiteBackup(entry.name))
        .map(entry => {
            const filename = path.join(directory, entry.name);
            return { filename, stat: fs.statSync(filename) };
        })
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const item of files.slice(SITE_BACKUP_MIRROR_RETENTION)) fs.rmSync(item.filename, { force: true });
}

async function mirrorSiteBackup(filename, mirrorDirectory) {
    const targetRoot = path.resolve(mirrorDirectory);
    const localRoot = path.resolve(SITE_BACKUP_DIR);
    if (!targetRoot || targetRoot === localRoot || targetRoot.startsWith(`${localRoot}${path.sep}`)) {
        throw new Error('异地灾备目录不能位于软件本机灾备目录内部');
    }
    ensureDirectory(targetRoot);
    const destination = path.join(targetRoot, path.basename(filename));
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.rmSync(temporary, { force: true });
    try {
        fs.copyFileSync(filename, temporary);
        const sourceHash = await sha256File(filename);
        const copiedHash = await sha256File(temporary);
        if (sourceHash !== copiedHash) throw new Error('异地灾备副本哈希校验失败');
        fs.renameSync(temporary, destination);
        pruneMirrorBackups(targetRoot);
        lastMirrorCopy = {
            at: new Date().toISOString(),
            directory: targetRoot,
            filename: path.basename(destination),
            sha256: sourceHash
        };
        return lastMirrorCopy;
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function listFiles(directory) {
    if (!fs.existsSync(directory)) return [];
    const files = [];
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const filename = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) visit(filename);
            if (entry.isFile()) files.push(filename);
        }
    };
    visit(directory);
    return files.sort((a, b) => a.localeCompare(b));
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

function pruneSiteBackups() {
    for (const backup of listSiteBackups().filter(backup => isManagedSiteBackup(backup.filename)).slice(SITE_BACKUP_RETENTION)) {
        fs.rmSync(path.join(SITE_BACKUP_DIR, backup.filename), { force: true });
    }
    const retained = listSiteBackups().filter(backup => isManagedSiteBackup(backup.filename));
    let totalBytes = retained.reduce((sum, backup) => sum + Number(backup.size || 0), 0);
    for (const backup of retained.slice(1).reverse()) {
        if (totalBytes <= SITE_BACKUP_MAX_TOTAL_BYTES) break;
        fs.rmSync(path.join(SITE_BACKUP_DIR, backup.filename), { force: true });
        totalBytes -= Number(backup.size || 0);
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
    const databaseStatus = getDatabaseBackupStatus();
    const config = loadSiteBackupConfig();
    return {
        supported: databaseStatus.supported,
        databaseType: databaseStatus.type,
        format: SITE_BACKUP_FORMAT,
        version: SITE_BACKUP_VERSION,
        retention: SITE_BACKUP_RETENTION,
        maxTotalBytes: SITE_BACKUP_MAX_TOTAL_BYTES,
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

async function addArchiveFile(manifestFiles, archivePath, filename) {
    const stat = fs.statSync(filename);
    manifestFiles.push({
        path: archivePath,
        size: stat.size,
        sha256: await sha256File(filename)
    });
}

async function createSiteBackup(uploadsRootDir) {
    return runSiteBackupOperation('导出', () => createSiteBackupUnlocked(uploadsRootDir));
}

async function createSiteBackupUnlocked(uploadsRootDir) {
    if (!getSiteBackupStatus().supported) {
        throw new Error(getSiteBackupStatus().toolError || '当前数据库不支持整站灾备导出');
    }

    ensureDirectory(SITE_BACKUP_DIR);
    const databaseBackup = await createDatabaseBackup('site-export');
    const databaseFilename = resolveDatabaseBackupPath(databaseBackup.filename);
    const databaseType = String(loadDatabaseConfig().type || '').toLowerCase();
    const databaseArchivePath = databaseType === 'mysql'
        ? 'database/mysql.sql.gz'
        : 'database/factory.db';
    const uploadsRoot = path.resolve(uploadsRootDir);
    ensureDirectory(SITE_IMPORT_DIR);
    const exportStaging = path.join(SITE_IMPORT_DIR, `export-${timestampToken()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    let temporary = null;

    try {
        const uploadedFiles = UPLOAD_GROUPS.flatMap(group => listFiles(path.join(uploadsRoot, group)).map(source => {
            const relative = path.relative(uploadsRoot, source).split(path.sep).join('/');
            const filename = path.join(exportStaging, ...relative.split('/'));
            ensureDirectory(path.dirname(filename));
            fs.copyFileSync(source, filename);
            return { filename, relative };
        }));
        const configFiles = listAvailableConfigFiles().flatMap(configFile => {
            const source = path.join(DATA_DIR, configFile.filename);
            if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return [];
            const filename = path.join(exportStaging, ...configFile.archivePath.split('/'));
            ensureDirectory(path.dirname(filename));
            fs.copyFileSync(source, filename);
            return [{ ...configFile, filename }];
        });
        const manifestFiles = [];
        await addArchiveFile(manifestFiles, databaseArchivePath, databaseFilename);

        for (const file of uploadedFiles) {
            await addArchiveFile(manifestFiles, `uploads/${file.relative}`, file.filename);
        }
        for (const file of configFiles) {
            await addArchiveFile(manifestFiles, file.archivePath, file.filename);
        }

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
        fs.rmSync(temporary, { force: true });

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(temporary);
            const archive = archiver('zip', { zlib: { level: 6 } });
            output.once('close', resolve);
            output.once('error', reject);
            archive.once('error', reject);
            archive.on('warning', error => {
                if (error.code !== 'ENOENT') reject(error);
            });
            archive.pipe(output);
            archive.file(databaseFilename, { name: databaseArchivePath });
            for (const file of uploadedFiles) {
                archive.file(file.filename, { name: `uploads/${file.relative}` });
            }
            for (const file of configFiles) {
                archive.file(file.filename, { name: file.archivePath });
            }
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
            archive.finalize().catch(reject);
        });
        fs.renameSync(temporary, destination);
        pruneSiteBackups();
        const backup = {
            ...backupDescriptor(destination),
            sha256: await sha256File(destination),
            uploadedFileCount: uploadedFiles.length,
            manifestCreatedAt: manifest.createdAt
        };
        const config = loadSiteBackupConfig();
        if (config.mirrorDirectory) {
            try {
                backup.mirror = await mirrorSiteBackup(destination, config.mirrorDirectory);
                lastSiteBackupError = null;
            } catch (error) {
                lastSiteBackupError = { at: new Date().toISOString(), operation: '异地复制', error: error.message };
                // 本机包仍然可用，但明确把异地失败返回给运维界面。
                backup.mirrorError = error.message;
            }
        }
        return backup;
    } finally {
        if (temporary) fs.rmSync(temporary, { force: true });
        fs.rmSync(exportStaging, { recursive: true, force: true });
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
    let totalSize = 0;
    for (const file of manifest.files) {
        const archivePath = normalizeArchivePath(file?.path);
        const size = Number(file?.size);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        if (declared.has(archivePath)) throw new Error(`整站备份清单存在重复文件: ${archivePath}`);
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

async function extractValidatedArchive(archiveFilename, stagingDirectory) {
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
        ensureDirectory(path.dirname(destination));
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
        fs.rmSync(destination, { force: true });
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

    ensureDirectory(SITE_IMPORT_DIR);
    const stagingDirectory = path.join(SITE_IMPORT_DIR, `restore-${timestampToken()}-${process.pid}`);
    const uploadsRoot = path.resolve(uploadsRootDir);
    const rollbackUploads = path.join(stagingDirectory, 'rollback-uploads');
    const rollbackConfig = path.join(stagingDirectory, 'rollback-config');
    let uploadsMutationStarted = false;
    let configMutationStarted = false;
    let uploadGroupsToRestore = ['models'];
    let configPathsToRestore = [];
    let preserveStaging = false;
    ensureDirectory(stagingDirectory);

    try {
        const { manifest, databaseFilename, configPaths } = await extractValidatedArchive(path.resolve(archiveFilename), stagingDirectory);
        uploadGroupsToRestore = Array.isArray(manifest.uploadGroups)
            ? [...new Set(manifest.uploadGroups.filter(group => UPLOAD_GROUPS.includes(group)))]
            : ['models'];
        configPathsToRestore = configPaths || [];
        for (const group of uploadGroupsToRestore) {
            const currentDirectory = path.join(uploadsRoot, group);
            const rollbackDirectory = path.join(rollbackUploads, group);
            if (fs.existsSync(currentDirectory)) fs.cpSync(currentDirectory, rollbackDirectory, { recursive: true });
        }

        uploadsMutationStarted = true;
        for (const group of uploadGroupsToRestore) {
            const currentDirectory = path.join(uploadsRoot, group);
            const restoredDirectory = path.join(stagingDirectory, 'uploads', group);
            fs.rmSync(currentDirectory, { recursive: true, force: true });
            if (fs.existsSync(restoredDirectory)) fs.cpSync(restoredDirectory, currentDirectory, { recursive: true });
            ensureDirectory(currentDirectory);
        }

        for (const archivePath of configPathsToRestore) {
            const descriptor = describeConfigArchivePath(archivePath);
            if (!descriptor) continue;
            const currentFilename = path.join(DATA_DIR, descriptor.filename);
            const rollbackFilename = path.join(rollbackConfig, descriptor.filename);
            if (fs.existsSync(currentFilename)) {
                ensureDirectory(path.dirname(rollbackFilename));
                fs.copyFileSync(currentFilename, rollbackFilename);
            }
        }
        configMutationStarted = configPathsToRestore.length > 0;
        for (const archivePath of configPathsToRestore) {
            const descriptor = describeConfigArchivePath(archivePath);
            if (!descriptor) continue;
            const restoredFilename = path.join(stagingDirectory, ...archivePath.split('/'));
            const parsed = JSON.parse(fs.readFileSync(restoredFilename, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) {
                throw new Error(`整站备份中的配置文件无效：${descriptor.filename}`);
            }
            const currentFilename = path.join(DATA_DIR, descriptor.filename);
            ensureDirectory(path.dirname(currentFilename));
            const temporary = `${currentFilename}.${process.pid}.restore.tmp`;
            fs.rmSync(temporary, { force: true });
            fs.copyFileSync(restoredFilename, temporary);
            fs.renameSync(temporary, currentFilename);
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
                    fs.rmSync(currentFilename, { force: true });
                    if (fs.existsSync(rollbackFilename)) fs.copyFileSync(rollbackFilename, currentFilename);
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
                    fs.rmSync(currentDirectory, { recursive: true, force: true });
                    if (fs.existsSync(rollbackDirectory)) fs.cpSync(rollbackDirectory, currentDirectory, { recursive: true });
                    ensureDirectory(currentDirectory);
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
        if (!preserveStaging) fs.rmSync(stagingDirectory, { recursive: true, force: true });
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
