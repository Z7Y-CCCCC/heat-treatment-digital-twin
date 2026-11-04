'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), out = path.join(root, '导入文件');
process.env.UPLOADS_DIR = path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop/uploads');
const bundle = require('../backend/services/modelAssetBundle'), authoring = require('../backend/services/motionAuthoring');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
    const inventory = JSON.parse(fs.readFileSync(path.join(out, '资产清单.json')));
    const assets = [...inventory.projects.flatMap(p => p.models), ...inventory.library];
    let motions = 0, sampledClips = 0;
    for (const record of assets) {
        const zip = path.join(out, record.zip), expanded = zip.slice(0, -4);
        const checked = await bundle.inspectAsset(zip);
        assert.equal(checked.inspectedSha256, record.sha256, record.zip);
        assert.equal(checked.model.id, record.id);
        for (const file of checked.files) {
            const bytes = fs.readFileSync(path.join(expanded, file.name));
            assert.equal(bytes.length, file.size); assert.equal(sha(bytes), file.sha256, record.zip + '/' + file.name);
        }
        assert.equal(sha(fs.readFileSync(authoring.localFile(record.originalPath))), checked.files.find(f => f.name === 'model.glb').sha256,
            '导出模型不是当前启动工程文件：' + record.originalPath);
        assert.ok(fs.existsSync(path.join(expanded, '模型动作配置.json')));
        if (checked.actions.length) { motions++; sampledClips += checked.actions.length; }
    }
    for (const source of inventory.sources) {
        const bytes = fs.readFileSync(path.join(out, source.file));
        assert.equal(bytes.length, source.bytes); assert.equal(sha(bytes), source.sha256);
    }
    const result = { success: true, verifiedAt: new Date().toISOString(), packageCount: assets.length,
        projectModelReferences: inventory.projects.reduce((n, p) => n + p.models.length, 0), formalAssets: inventory.library.length,
        activeFactory: inventory.projects.find(p => p.active)?.name, packagesWithSampledMotion: motions, sampledClips,
        retainedBlenderSources: inventory.sources.filter(s => s.file.endsWith('.blend')).length,
        databaseBackupsIncluded: false, credentialsIncluded: false,
        checks: ['每个资产 ZIP 通过完整模型/动作校验', '全部展开 GLB/动作 JSON 的尺寸和 SHA256 与 ZIP 相符',
            '导出的模型与当前启动工程文件一致', '独立建模源工程复制哈希正确'] };
    fs.writeFileSync(path.join(root, 'output/project-import-assets-verification-20261104.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
