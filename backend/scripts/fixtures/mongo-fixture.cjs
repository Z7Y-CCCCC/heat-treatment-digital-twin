'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { findFreePort, startLoggedProcess, waitUntil, requireTestPath } = require('../integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../../../desktop/scripts/smoke-sandbox.cjs');
async function createMongoFixture(directory) {
    requireTestPath(directory);
    const name = `dt_fixture_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
    const username = 'readonly_' + crypto.randomBytes(5).toString('hex'), password = crypto.randomBytes(24).toString('hex');
    const adminName = 'fixture_admin', adminPassword = crypto.randomBytes(24).toString('hex');
    let server, admin, port;
    const external = process.env.MONGODB_TEST_URI;
    if (external) {
        const parsed = new URL(external);
        if (process.env.MONGODB_TEST_DISPOSABLE !== 'true' || parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname))
            throw new Error('MongoDB test URI must be an explicitly disposable loopback fixture');
        port = Number(parsed.port || 27017);
    } else {
        const executable = process.env.MONGOD_TEST_EXECUTABLE;
        if (!executable || !fs.existsSync(executable)) throw new Error('Set MONGOD_TEST_EXECUTABLE to a verified official test binary; no database server is installed by this test');
        port = await findFreePort();
        fs.mkdirSync(path.join(directory, 'mongod-data'), { recursive: true });
    }
    const uri = `mongodb://127.0.0.1:${port}`;
    async function start() {
        server = startLoggedProcess(process.env.MONGOD_TEST_EXECUTABLE, ['--bind_ip', '127.0.0.1', '--port', String(port), '--auth', '--dbpath', path.join(directory, 'mongod-data'), '--logpath', path.join(directory, 'mongod.log'), '--setParameter', 'diagnosticDataCollectionEnabled=false'], { cwd: directory, env: process.env, logFile: path.join(directory, 'mongod-console.log') });
        await waitUntil(async () => {
            if (server.exitCode != null) throw new Error('Owned mongod exited: ' + fs.readFileSync(path.join(directory, 'mongod-console.log'), 'utf8').slice(-1500));
            const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 300, appName: 'OwnedMongoFixture' });
            try { await probe.connect(); await probe.db('admin').command({ ping: 1 }); return true; }
            catch { return false; } finally { await probe.close(); }
        }, 30000, 'owned MongoDB starts');
    }
    try {
        if (!external) {
            await start();
            const bootstrap = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, appName: 'OwnedMongoFixture' });
            try { await bootstrap.connect(); await bootstrap.db('admin').command({ createUser: adminName, pwd: adminPassword, roles: ['root'] }); }
            finally { await bootstrap.close(); }
        }
        admin = new MongoClient(external || uri, { ...(external ? process.env.MONGODB_TEST_ADMIN_USER ? { auth: { username: process.env.MONGODB_TEST_ADMIN_USER, password: process.env.MONGODB_TEST_ADMIN_PASSWORD }, authSource: 'admin' } : {} : { auth: { username: adminName, password: adminPassword }, authSource: 'admin' }), serverSelectionTimeoutMS: 3000, appName: 'OwnedMongoFixture' });
        await admin.connect();
        const db = admin.db(name);
        await db.command({ createUser: username, pwd: password, roles: [{ role: 'read', db: name }] });
        return { database: db, client: admin, name, username, password, port, uri,
            config: { name: 'MongoDB owned fixture', sourceType: 'database', type: 'mongodb', host: '127.0.0.1', port, database: name,
                user: username, password, defaultSchema: name, queryTimeoutMs: 2000, encrypt: false, trustServerCertificate: false, enabled: true },
            async restart() {
                if (external) throw new Error('External fixture processes are never controlled');
                await stopOwnedSmokeProcess(server); await start();
            },
            async stopDatabase() { if (external) throw new Error('External fixture processes are never controlled'); await stopOwnedSmokeProcess(server); },
            async close() {
                // Only the cryptographically named database created above is removed.
                if (!/^dt_fixture_\d+_[a-f0-9]{10}$/.test(name)) throw new Error('Unsafe fixture database name');
                try { await db.command({ dropAllUsersFromDatabase: 1 }); await db.dropDatabase(); } finally { await admin.close(); await stopOwnedSmokeProcess(server); }
            }, external: Boolean(external) };
    } catch (error) { await admin?.close(); await stopOwnedSmokeProcess(server); throw error; }
}
module.exports = { createMongoFixture };
