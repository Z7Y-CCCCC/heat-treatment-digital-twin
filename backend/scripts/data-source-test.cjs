const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

async function main() {
    const root = createRunDirectory('data-source');
    const database = path.join(root, 'external.db');
    await createTestDatabase(database);
    const Database = require('better-sqlite3');
    const seed = new Database(database);
    seed.exec(`CREATE TABLE designer_metrics (
        device_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        actual REAL NOT NULL,
        target REAL NOT NULL
    )`);
    seed.exec(`CREATE TABLE designer_part_metrics (
        part_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        value REAL NOT NULL
    )`);
    seed.prepare('INSERT INTO designer_metrics(device_id, recorded_at, actual, target) VALUES (?, ?, ?, ?)').run('Device_01', '2026-08-15 10:00:00', 40, 50);
    seed.prepare('INSERT INTO designer_metrics(device_id, recorded_at, actual, target) VALUES (?, ?, ?, ?)').run('Device_01', '2026-08-15 10:05:00', 80, 100);
    seed.prepare('INSERT INTO designer_metrics(device_id, recorded_at, actual, target) VALUES (?, ?, ?, ?)').run('Device_02', '2026-08-15 10:05:00', 10, 100);
    seed.prepare('INSERT INTO designer_part_metrics(part_id, recorded_at, value) VALUES (?, ?, ?)').run('front_door_open', '2026-08-15 10:05:00', 55);
    seed.prepare('INSERT INTO designer_part_metrics(part_id, recorded_at, value) VALUES (?, ?, ?)').run('rear_fan_rotate', '2026-08-15 10:05:00', 88);
    seed.close();
    process.env.APP_DATA_DIR = root;
    process.env.DATA_SOURCE_BACKUP_DIR = path.join(root, 'data-source-backups');

    const service = require('../services/dataSources');
    const connection = service.saveDataSource({
        id: 'test_external',
        name: '测试外部数据库',
        type: 'sqlite',
        filename: database,
        enabled: true
    });
    const databaseTest = await service.testDataSource(connection);
    if (!databaseTest.success) throw new Error(`外部数据库连接测试失败：${databaseTest.error || databaseTest.health?.message}`);

    const apiServer = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (req.url === '/auth') {
            if (req.headers['x-api-key'] !== 'test-key') {
                res.writeHead(401);
                res.end('unauthorized');
                return;
            }
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.url === '/forbidden') {
            res.writeHead(403);
            res.end('forbidden');
            return;
        }
        if (req.url === '/error') {
            res.writeHead(500);
            res.end('error');
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });
    apiServer.unref();
    await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const apiPort = apiServer.address().port;
    const apiSource = service.saveDataSource({
        id: 'test_http_api',
        name: '测试现场接口',
        sourceType: 'http_api',
        baseUrl: `http://127.0.0.1:${apiPort}`,
        healthPath: '/health',
        authType: 'none',
        requestTimeoutMs: 2000,
        enabled: true
    });
    const healthyApi = await service.testDataSource(apiSource);
    if (!healthyApi.success || healthyApi.health.status !== 'healthy' || healthyApi.health.httpStatus !== 200) {
        throw new Error(`HTTP API 健康检查失败：${JSON.stringify(healthyApi)}`);
    }
    const authApi = await service.testDataSource({
        sourceType: 'http_api',
        baseUrl: `http://127.0.0.1:${apiPort}`,
        healthPath: '/auth',
        authType: 'api_key',
        apiKeyHeader: 'X-API-Key',
        apiKey: 'wrong-key',
        requestTimeoutMs: 2000
    });
    if (authApi.success || authApi.health.status !== 'auth_failed' || authApi.health.httpStatus !== 401) {
        throw new Error(`HTTP API 认证失败未被区分：${JSON.stringify(authApi)}`);
    }
    const errorApi = await service.testDataSource({
        sourceType: 'http_api',
        baseUrl: `http://127.0.0.1:${apiPort}`,
        healthPath: '/error',
        authType: 'none',
        requestTimeoutMs: 2000
    });
    if (errorApi.success || errorApi.health.status !== 'http_error' || errorApi.health.httpStatus !== 500) {
        throw new Error(`HTTP API 响应错误未被区分：${JSON.stringify(errorApi)}`);
    }
    const publicSources = service.listDataSources().connections;
    const publicApi = publicSources.find(item => item.id === apiSource.id);
    if (!publicApi || publicApi.apiKey || publicApi.token || publicApi.password === 'test-key') {
        throw new Error('HTTP API 凭据没有被正确隐藏');
    }
    const backupRulesWithApi = service.saveBackupConfig({ selectedConnectionIds: [connection.id, apiSource.id] });
    if (backupRulesWithApi.selectedConnectionIds.includes(apiSource.id)
        || service.getBackupStatus().connections.some(item => item.id === apiSource.id)) {
        throw new Error('HTTP API 被错误加入数据库备份');
    }
    const tables = await service.listTables(connection.id);
    const settingsTable = tables.find(item => item.name === 'settings') || tables[0];
    if (!settingsTable) throw new Error('没有读取到任何数据表');
    const columns = await service.listColumns(connection.id, settingsTable.schema, settingsTable.name);
    const field = columns.find(item => item.name === 'value') || columns[0];
    if (!field) throw new Error('没有读取到任何字段');
    const preview = await service.previewBinding({
        connectionId: connection.id,
        schema: settingsTable.schema,
        table: settingsTable.name,
        field: field.name,
        valueMode: 'latest',
        rowLimit: 5
    });
    const runtime = await service.readRuntimeBindings([{ id: 'widget_test', data: {
        mode: 'database', connectionId: connection.id, schema: settingsTable.schema,
        table: settingsTable.name, field: field.name, valueMode: 'latest'
    } }]);
    const multiSource = {
        mode: 'database',
        formula: '(a / b) * 100',
        formulaLabel: '完成率',
        datasets: [
            { alias: 'a', label: '实际值', connectionId: connection.id, table: 'designer_metrics', field: 'actual', timeField: 'recorded_at', orderBy: 'recorded_at', valueMode: 'list', rowLimit: 10, contextKey: 'deviceId', contextField: 'device_id' },
            { alias: 'b', label: '目标值', connectionId: connection.id, table: 'designer_metrics', field: 'target', timeField: 'recorded_at', orderBy: 'recorded_at', valueMode: 'list', rowLimit: 10, contextKey: 'deviceId', contextField: 'device_id' }
        ],
        context: { deviceId: 'Device_01' }
    };
    const multiPreview = await service.previewBinding(multiSource);
    if (multiPreview.value !== 80 || multiPreview.rows.length !== 2 || multiPreview.series.length !== 3) {
        throw new Error(`多数据项公式或设备过滤失效：${JSON.stringify(multiPreview)}`);
    }
    const multiRuntime = await service.readRuntimeBindings([{ id: 'widget_multi', data: multiSource }], { deviceId: 'Device_02' });
    if (multiRuntime.widget_multi?.value !== 10 || multiRuntime.widget_multi?.series?.length !== 3) {
        throw new Error(`运行时设备上下文过滤失效：${JSON.stringify(multiRuntime.widget_multi)}`);
    }
    const partRuntime = await service.readRuntimeBindings([{ id: 'widget_part', data: {
        mode: 'database', connectionId: connection.id, table: 'designer_part_metrics', field: 'value',
        timeField: 'recorded_at', orderBy: 'recorded_at', valueMode: 'latest',
        contextKey: 'partId', contextField: 'part_id'
    } }], { partId: 'front_door_open' });
    if (partRuntime.widget_part?.value !== 55) {
        throw new Error(`运行时部件上下文过滤失效：${JSON.stringify(partRuntime.widget_part)}`);
    }
    const configuredBackupRules = service.saveBackupConfig({
        startupEnabled: false,
        scheduledEnabled: true,
        shutdownEnabled: true,
        selectedConnectionIds: [connection.id],
        intervalHours: 6,
        retention: 3
    });
    if (configuredBackupRules.startupEnabled !== false
        || configuredBackupRules.scheduledEnabled !== true
        || configuredBackupRules.shutdownEnabled !== true) {
        throw new Error('独立备份触发规则未正确保存');
    }
    const backup = await service.createConnectionBackup(connection.id, 'test');
    const backupPath = path.join(root, 'data-source-backups', connection.id, backup.filename);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size < 32) throw new Error('外部数据库压缩备份未生成');
    await service.stopDataSourceMaintenance({ backup: true, reason: 'shutdown' });
    const backupDirectory = path.dirname(backupPath);
    const shutdownBackups = fs.readdirSync(backupDirectory).filter(filename => filename.includes('-shutdown.'));
    if (shutdownBackups.length !== 1) throw new Error('启用正常退出备份后未生成 shutdown 备份');

    service.saveBackupConfig({
        startupEnabled: false,
        scheduledEnabled: false,
        shutdownEnabled: false,
        selectedConnectionIds: [connection.id],
        intervalHours: 6,
        retention: 3
    });
    const countBeforeDisabledShutdown = fs.readdirSync(backupDirectory).length;
    await service.stopDataSourceMaintenance({ backup: true, reason: 'shutdown-disabled-check' });
    if (fs.readdirSync(backupDirectory).length !== countBeforeDisabledShutdown) {
        throw new Error('关闭正常退出备份后仍生成了备份');
    }

    await new Promise(resolve => apiServer.close(resolve));
    console.log(JSON.stringify({
        success: true,
        connection: connection.id,
        tables: tables.length,
        columns: columns.length,
        preview: preview.value,
        runtimeQuality: runtime.widget_test?.quality,
        multiDatasetFormula: multiPreview.value,
        deviceContextFormula: multiRuntime.widget_multi?.value,
        partContextValue: partRuntime.widget_part?.value,
        httpApiHealth: healthyApi.health.status,
        httpApiAuthFailure: authApi.health.status,
        httpApiHttpFailure: errorApi.health.status,
        httpApiExcludedFromBackup: true,
        backup: backup.filename,
        shutdownBackup: shutdownBackups[0],
        configurableTriggers: true
    }, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
}

main().catch(error => {
    console.error(JSON.stringify({ success: false, error: error.stack || error.message }, null, 2));
    process.exitCode = 1;
});
