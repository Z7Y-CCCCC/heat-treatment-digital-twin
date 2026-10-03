import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

const { descriptor } = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8'))
function findBackupRow(node) {
    if (node.type === 1 && node.props?.some(prop => prop.name === 'for' && prop.exp?.content === 'backup in databaseBackupStatus.backups')) return node
    for (const child of node.children || []) { const match = findBackupRow(child); if (match) return match }
}
const row = findBackupRow(baseParse(descriptor.template.content))
assert.ok(row, 'Database backup row was not found')
async function renderBackup(valid, busy = false) {
    return renderToString(createSSRApp({
        template: row.loc.source,
        data: () => ({ databaseBackupStatus: { backups: [{ filename: 'fixture.sql.gz', valid, size: 1 }] }, databaseBackupBusy: busy }),
        methods: {
            formatBackupTime: () => 'time', formatBackupSize: () => 'size',
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
        assert.equal(disabled(html, '下载'), valid === false)
        assert.equal(disabled(html, '恢复'), valid === false)
    }
    const busy = await renderBackup(null, true)
    assert.equal(disabled(busy, '下载'), false)
    assert.equal(disabled(busy, '恢复'), true)
})
