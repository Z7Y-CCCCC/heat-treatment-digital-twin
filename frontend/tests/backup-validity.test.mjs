import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileScript, parse } from 'vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

const { descriptor } = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8'))
const copyPathUrl = new URL('../src/views/admin/components/CopyPathButton.vue', import.meta.url)
const { descriptor: copyDescriptor } = parse(await readFile(copyPathUrl, 'utf8'))
let copyScript = compileScript(copyDescriptor, { id: 'backup-validity-copy-path', inlineTemplate: true }).content
for (const match of [...copyScript.matchAll(/from\s+(['"])([^'"]+)\1/g)]) copyScript = copyScript.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], copyPathUrl).href : import.meta.resolve(match[2]))}`)
const { default: CopyPathButton } = await import(`data:text/javascript;base64,${Buffer.from(copyScript).toString('base64')}`)
const fullPath = 'C:\\数据库备份\\fixture.sql.gz'
function findBackupRow(node) {
    if (node.type === 1 && node.props?.some(prop => prop.name === 'for' && prop.exp?.content === 'backup in databaseBackupStatus.backups')) return node
    for (const child of node.children || []) { const match = findBackupRow(child); if (match) return match }
}
const row = findBackupRow(baseParse(descriptor.template.content))
assert.ok(row, 'Database backup row was not found')
async function renderBackup(valid, busy = false) {
    return renderToString(createSSRApp({
        template: row.loc.source,
        components: { CopyPathButton },
        directives: { permission: { getSSRProps: () => ({}) } }, // validity rendering is independent of access grants
        data: () => ({ controlPermissionPage: 'settings.database', databaseBackupStatus: { directory: 'C:\\数据库备份', backups: [{ filename: 'fixture.sql.gz', fullPath, valid, size: 1 }] }, databaseBackupBusy: busy }),
        methods: {
            formatBackupTime: () => 'time', formatBackupSize: () => 'size',
            backupFilePath: (filename, directory) => `${directory}\\${filename}`,
            downloadDatabaseBackup() {}, restoreDatabaseBackup() {}, deleteDatabaseBackup() {}
        }
    }))
}
function disabled(html, label) {
    const button = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find(match => match[2] === label)
    assert.ok(button, `Missing ${label} button`)
    return /\bdisabled\b/.test(button[1])
}
test('database backup validity has three distinct labels and only known corruption blocks download/restore', async () => {
    for (const [valid, label, css] of [[true, '已校验', 'is-valid'], [false, '已损坏', 'is-invalid'], [null, '恢复时校验', 'is-unverified']]) {
        const html = await renderBackup(valid)
        assert.ok(html.includes(label) && html.includes(css))
        assert.ok(html.includes(`aria-label="复制文件路径：${fullPath}"`) && html.includes(`>${fullPath}</span>`), 'full backup path is visible and copyable')
        assert.equal(disabled(html, '下载'), valid === false)
        assert.equal(disabled(html, '恢复'), valid === false)
    }
    const busy = await renderBackup(null, true)
    assert.equal(disabled(busy, '下载'), false)
    assert.equal(disabled(busy, '恢复'), true)
})
