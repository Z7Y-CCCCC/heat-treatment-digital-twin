'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyAndHash } = require('../utils/backupStorage');
const { renameAtomic } = require('../utils/atomicRename');

const dataDirectory = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(__dirname, '..', 'data');
const intentFilename = path.join(dataDirectory, 'site-recovery-intent.json');
const evidenceRoot = path.join(dataDirectory, 'site-recovery-evidence');

function siteRecoveryStatus() {
    try {
        const stat = fs.statSync(intentFilename);
        if (stat.size > 32768) throw new Error('Recovery intent is too large');
        const intent = JSON.parse(fs.readFileSync(intentFilename, 'utf8'));
        if (!/^[a-f0-9-]{36}$/i.test(intent.operationId || '') || !['prepared', 'before-business-restore', 'business-restored', 'spool-committed', 'rolled-back'].includes(intent.phase)
            || path.resolve(intent.evidenceDirectory || '') !== path.join(evidenceRoot, intent.operationId)) throw new Error('Invalid recovery intent identity');
        return { ...intent, pending: true, requiresRecovery: true, intentFilename };
    } catch (error) {
        if (error.code === 'ENOENT') return { pending: false };
        return { pending: true, requiresRecovery: true, phase: 'unreadable', error: error.message, intentFilename };
    }
}

function assertNoPendingSiteRecovery() {
    const status = siteRecoveryStatus();
    if (status.pending) {
        const error = new Error(`整站恢复尚未确认完成（${status.phase || 'unknown'}）；保留证据 ${intentFilename}，请先处理待决恢复`);
        error.code = 'SITE_RECOVERY_PENDING';
        throw error;
    }
}

async function durableWrite(intent, { createOnly = false } = {}) {
    const temporary = `${intentFilename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let file;
    try {
        await fs.promises.mkdir(dataDirectory, { recursive: true });
        file = await fs.promises.open(temporary, 'wx', 0o600);
        await file.writeFile(JSON.stringify(intent, null, 2), 'utf8');
        await file.sync();
        await file.close(); file = null;
        if (createOnly) await fs.promises.link(temporary, intentFilename);
        else await renameAtomic(temporary, intentFilename);
        // Windows does not expose directory fsync. On systems that do, flush
        // the directory rename as well as the intent file contents.
        if (process.platform !== 'win32') {
            const directory = await fs.promises.open(dataDirectory, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally {
        await file?.close();
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
}

async function beginSiteRecoveryIntent({ archiveFilename, alarmSnapshotFilename, rollbackDatabaseFilename, stagingDirectory, uploadsRoot, databaseType }) {
    assertNoPendingSiteRecovery();
    const operationId = crypto.randomUUID();
    const evidenceDirectory = path.join(evidenceRoot, operationId);
    await fs.promises.mkdir(evidenceDirectory, { recursive: true });
    const files = {};
    try {
        for (const [name, source] of Object.entries({ 'source.zip': archiveFilename,
            'alarm-outbox.db': alarmSnapshotFilename,
            [databaseType === 'mysql' ? 'database-before.sql.gz' : 'database-before.db']: rollbackDatabaseFilename })) {
            if (!source) continue;
            const destination = path.join(evidenceDirectory, name);
            const verified = await copyAndHash(source, destination);
            const file = await fs.promises.open(destination, 'r+');
            try { await file.sync(); } finally { await file.close(); }
            files[name] = { filename: destination, ...verified };
        }
        const intent = { operationId, phase: 'prepared', startedAt: new Date().toISOString(), evidenceDirectory,
            stagingDirectory, uploadsRoot, databaseType, files };
        await durableWrite(intent, { createOnly: true });
        return intent;
    } catch (error) {
        // No mutations have started yet. Once the intent exists its evidence
        // must never be swept as an ordinary temporary directory.
        const published = siteRecoveryStatus();
        if (published.operationId === operationId) error.recoveryIntent = published;
        else await fs.promises.rm(evidenceDirectory, { recursive: true, force: true });
        throw error;
    }
}

async function updateSiteRecoveryIntent(intent, phase, extra = {}) {
    if (siteRecoveryStatus().operationId !== intent.operationId) throw new Error('Recovery intent ownership changed');
    const next = { ...intent, ...extra, phase, updatedAt: new Date().toISOString() };
    await durableWrite(next);
    Object.assign(intent, next);
}

async function finishSiteRecoveryIntent(intent, phase) {
    await updateSiteRecoveryIntent(intent, phase);
    const resolved = path.resolve(intent.evidenceDirectory);
    if (path.dirname(resolved) !== path.resolve(evidenceRoot) || path.basename(resolved) !== intent.operationId) {
        throw new Error('Recovery evidence directory escaped its owned root');
    }
    // An atomic move first retires the authority only after both commits (or
    // all rollbacks). If Windows refuses the move, all pending evidence stays.
    await renameAtomic(intentFilename, path.join(resolved, 'completed-intent.json'));
    try { await fs.promises.rm(resolved, { recursive: true, force: true }); return {}; }
    catch (error) { return { cleanupWarning: error.message, evidenceDirectory: resolved }; }
}

module.exports = { siteRecoveryStatus, assertNoPendingSiteRecovery, beginSiteRecoveryIntent,
    updateSiteRecoveryIntent, finishSiteRecoveryIntent, intentFilename, evidenceRoot };
