// Read-only audit of the Git index, plus optional reachable history. Never
// prints secret values and never deletes files or rewrites history.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });

function forbidden(filename) {
    if (/(^|\/)(node_modules|dist|output|logs|tmp|temp|\.cache)(\/|$)/i.test(filename)) return 'generated directory';
    if (/^unity-client\/(Library|Temp|Obj|Builds?|Logs|UserSettings|MemoryCaptures|Recordings)\//i.test(filename)) return 'Unity generated directory';
    if (/^(native-admin-host|collector-service)\/(bin|obj)\//i.test(filename) || /^tools\/[^/]+\/(bin|obj)\//i.test(filename)) return '.NET generated directory';
    if (/^(安装包|desktop\/resources|backend\/(data|uploads))\//.test(filename)) return 'local runtime data';
    if (/\.(blend[12]|tmp|bak|log|unitypackage|exe|dll|pfx|p12|key|pem|db|db-wal|db-shm|sqlite3?|dump)$/i.test(filename) || /\.sql\.gz$/i.test(filename)) return 'binary build, backup or private data';
    if (/(^|\/)\.env($|\.)/.test(filename) && !/\.env\.(example|sample)$/.test(filename)) return 'local environment';
    if (/(^|\/)(database-config|license|admin-auth|credentials)\.json$/i.test(filename)) return 'local credentials';
    if (/_working\.blend$|\/backup-before-[^/]+\/|_runtime_check\.png$/i.test(filename)) return 'model intermediate';
    if (/^backend\/assets\/models\/pit_furnace_references_v1\/.*\/geometry-validation\.json$/.test(filename)) return 'generated model report';
    if (/^unity-client\/Assets\/Equipment\/PitFurnaceReferences\/.*(?:verification\.json|preview\.png)(?:\.meta)?$/.test(filename)) return 'generated Unity evidence';
    return '';
}

const signatures = [
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
    ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];
function secretKinds(buffer) {
    if (buffer.includes(0)) return []; // model/texture data is binary
    const text = buffer.toString('utf8');
    return signatures.filter(([, expression]) => expression.test(text)).map(([kind]) => kind);
}

function objectMetadata(ids) {
    if (!ids.length) return [];
    return execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        cwd: root, windowsHide: true, input: ids.join('\n') + '\n', maxBuffer: 16 * 1024 * 1024
    }).toString('utf8').trim().split('\n').map(line => line.split(' '));
}

function scanBlobs(candidates, paths) {
    const problems = [];
    for (let i = 0; i < candidates.length; i += 50) {
        const batch = candidates.slice(i, i + 50);
        const result = execFileSync('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true,
            input: batch.map(([id]) => id).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 });
        let offset = 0;
        for (const [id, , bytes] of batch) {
            const end = result.indexOf(10, offset);
            if (end < offset || !result.subarray(offset, end).toString().startsWith(id + ' blob ')) throw new Error('Unexpected blob response');
            const content = result.subarray(end + 1, end + 1 + Number(bytes));
            for (const kind of secretKinds(content)) problems.push({ id, filename: paths.get(id), reason: kind });
            offset = end + 2 + Number(bytes);
        }
    }
    return problems;
}

function auditIndex() {
    const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
    const problems = [], blobs = new Map();
    let totalBytes = 0, largestBytes = 0;
    for (const entry of entries) {
        const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error('Unable to parse Git index');
        const [, mode, id, stage, filename] = match;
        if (stage !== '0') problems.push({ filename, reason: 'unresolved merge' });
        if (mode === '160000') continue;
        const reason = forbidden(filename);
        if (reason) problems.push({ filename, reason });
        if (!blobs.has(id)) blobs.set(id, filename);
    }
    const meta = objectMetadata([...blobs.keys()]);
    for (const [id, type, bytes] of meta) {
        if (type !== 'blob') throw new Error('Unexpected non-blob index object');
        const size = Number(bytes), filename = blobs.get(id);
        totalBytes += size; largestBytes = Math.max(largestBytes, size);
        if (size >= 100 * 1024 * 1024) problems.push({ filename, reason: 'exceeds GitHub per-file limit' });
    }
    problems.push(...scanBlobs(meta.filter(([, , bytes]) => Number(bytes) <= 2 * 1024 * 1024), blobs));
    return { files: entries.length, uniqueBlobs: blobs.size, uniqueBlobMB: +(totalBytes / 1048576).toFixed(2), largestMB: +(largestBytes / 1048576).toFixed(2), problems };
}

function auditHistory() {
    const objects = git(['rev-list', '--objects', '--all']).toString('utf8').split('\n').filter(Boolean);
    const paths = new Map(objects.map(line => { const space = line.indexOf(' '); return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]; }));
    const meta = objectMetadata([...paths.keys()]);
    const candidates = meta.filter(([, type, size]) => type === 'blob' && Number(size) <= 2 * 1024 * 1024);
    const problems = scanBlobs(candidates, paths);
    return { reachableObjects: objects.length, scannedTextCandidates: candidates.length, problems,
        note: 'Historical generated/model backups are retained; history is not rewritten. This signature scan is not a complete security audit.' };
}

const index = auditIndex();
const history = process.argv.includes('--history') ? auditHistory() : undefined;
const result = { success: !index.problems.length && !history?.problems.length, index, ...(history ? { history } : {}) };
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
