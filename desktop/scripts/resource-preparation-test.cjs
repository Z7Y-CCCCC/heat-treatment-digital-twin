const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { prepareResourceDirectory, copySqliteSnapshot } = require('./resource-preparation.cjs');
const output = path.resolve(__dirname, '../../output');
fs.mkdirSync(output, { recursive: true });

test('failed resource build preserves the complete previous resources', async () => {
    const fixture = fs.mkdtempSync(path.join(output, 'resource-failure-'));
    const target = path.join(fixture, 'resources');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'previous.txt'), 'last successful build');
    await assert.rejects(prepareResourceDirectory(target, async staging => {
        fs.writeFileSync(path.join(staging, 'partial.txt'), 'incomplete');
        throw new Error('fixture build failure');
    }), /fixture build failure/);
    assert.equal(fs.readFileSync(path.join(target, 'previous.txt'), 'utf8'), 'last successful build');
    assert.deepEqual(fs.readdirSync(fixture), ['resources']);
});

test('a complete build replaces resources only after all components succeed', async () => {
    const fixture = fs.mkdtempSync(path.join(output, 'resource-success-'));
    const target = path.join(fixture, 'resources');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'previous.txt'), 'old');
    const result = await prepareResourceDirectory(target, async staging => {
        assert.equal(fs.existsSync(path.join(target, 'previous.txt')), true);
        fs.writeFileSync(path.join(staging, 'current.txt'), 'complete');
        return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(fs.readdirSync(target), ['current.txt']);
    assert.deepEqual(fs.readdirSync(fixture), ['resources']);
});

test('SQLite snapshot includes committed WAL pages without checkpointing the source', async () => {
    const Database = require('../../backend/node_modules/better-sqlite3');
    const fixture = fs.mkdtempSync(path.join(output, 'resource-snapshot-'));
    const sourceFile = path.join(fixture, 'source.db');
    const destination = path.join(fixture, 'snapshot.db');
    const source = new Database(sourceFile);
    try {
        source.pragma('journal_mode = WAL');
        source.exec('CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES (\'committed WAL row\')');
        const walBefore = fs.readFileSync(`${sourceFile}-wal`);
        assert.ok(walBefore.length > 0);
        await copySqliteSnapshot(sourceFile, destination, Database);
        assert.deepEqual(fs.readFileSync(`${sourceFile}-wal`), walBefore);
        const snapshot = new Database(destination, { readonly: true, fileMustExist: true });
        try {
            assert.equal(snapshot.prepare('SELECT value FROM fixture').get().value, 'committed WAL row');
            assert.equal(snapshot.pragma('quick_check', { simple: true }), 'ok');
            assert.equal(snapshot.pragma('journal_mode', { simple: true }), 'delete');
        } finally { snapshot.close(); }
    } finally { source.close(); }
});
