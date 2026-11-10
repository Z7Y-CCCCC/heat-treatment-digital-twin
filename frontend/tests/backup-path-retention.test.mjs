import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, effectScope, h, nextTick } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { copyTextToClipboard } from '../src/views/admin/utils/clipboard.js'
import { useSystemSettings } from '../src/views/admin/composables/useSystemSettings.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { adminApi } from '../src/config/factoryConfig.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { deferred, installBrowser } from './helpers.mjs'

const path = 'C:\\备份文件\\非常长的完整路径\\factory-20261109-scheduled.sql.gz'
const componentUrl = new URL('../src/views/admin/components/CopyPathButton.vue', import.meta.url)
const { descriptor } = parse(await readFile(componentUrl, 'utf8'))
let script = compileScript(descriptor, { id: 'copy-path-test' }).content
for (const match of [...script.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    script = script.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], componentUrl).href : import.meta.resolve(match[2]))}`)
}
const { default: CopyPathButton } = await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`)
CopyPathButton.render = () => null

async function mounted(t, initialPath = path) {
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const root = {}
    let vm
    async function render(nextPath) {
        const vnode = h(CopyPathButton, { path: nextPath })
        renderer.render(vnode, root)
        vm = vnode.component.setupState
        await nextTick()
    }
    t.after(() => renderer.render(null, root))
    await render(initialPath)
    return { get vm() { return vm }, render }
}

function fallbackFixture(t, { succeeds = true, throws = false } = {}) {
    const browser = installBrowser(t)
    const calls = []
    const focused = { selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', focus: options => calls.push(['restore-focus', options]), setSelectionRange: (...range) => calls.push(['restore-input', range]) }
    const originalRange = { cloneRange: () => 'saved-range' }
    const selection = { rangeCount: 1, getRangeAt: () => originalRange, removeAllRanges: () => calls.push(['clear-selection']), addRange: range => calls.push(['restore-selection', range]) }
    const textarea = { style: {}, setAttribute() {}, focus() {}, select: () => calls.push(['select', textarea.value]), remove: () => calls.push(['remove']) }
    browser.replace('document', {
        activeElement: focused, getSelection: () => selection,
        createElement: name => { assert.equal(name, 'textarea'); return textarea },
        body: { appendChild: node => { assert.equal(node, textarea); calls.push(['append']) } },
        execCommand: command => { calls.push(['command', command]); if (throws) throw new Error('denied'); return succeeds }
    })
    return { browser, calls, textarea }
}

test('modern clipboard copies the complete unmodified path', async t => {
    const { replace } = installBrowser(t)
    const copied = []
    replace('navigator', { clipboard: { writeText: async text => copied.push(text) } })
    await copyTextToClipboard(` ${path} `)
    assert.deepEqual(copied, [` ${path} `])
})

for (const modern of ['missing', 'rejected']) test(`clipboard fallback works when the modern API is ${modern} and restores focus/selection`, async t => {
    const { browser, calls, textarea } = fallbackFixture(t)
    browser.replace('navigator', modern === 'missing' ? {} : { clipboard: { writeText: async () => { throw new Error('permission denied') } } })
    await copyTextToClipboard(path)
    assert.equal(textarea.value, path)
    assert.ok(calls.some(call => call[0] === 'command' && call[1] === 'copy'))
    assert.deepEqual(calls.slice(-5), [['remove'], ['restore-focus', { preventScroll: true }], ['restore-input', [2, 5, 'backward']], ['clear-selection'], ['restore-selection', 'saved-range']])
    assert.ok(calls.some(call => call[0] === 'restore-input' && call[1][0] === 2 && call[1][1] === 5))
    assert.ok(calls.some(call => call[0] === 'restore-selection' && call[1] === 'saved-range'))
    assert.ok(calls.findIndex(call => call[0] === 'remove') < calls.findIndex(call => call[0] === 'restore-focus'))
})

for (const failure of ['false', 'exception']) test(`failed fallback (${failure}) never reports success and always cleans up`, async t => {
    const { browser, calls } = fallbackFixture(t, { succeeds: false, throws: failure === 'exception' })
    browser.replace('navigator', {})
    await assert.rejects(copyTextToClipboard(path))
    assert.ok(calls.some(call => call[0] === 'remove'))
    assert.ok(calls.some(call => call[0] === 'restore-focus'))
    assert.ok(calls.some(call => call[0] === 'restore-selection'))
})

test('path component copies once, shows success, clears stale feedback and never copies missing paths', async t => {
    const { replace } = installBrowser(t)
    const copied = []
    replace('navigator', { clipboard: { writeText: async value => copied.push(value) } })
    const fixture = await mounted(t)
    await fixture.vm.copyPath()
    assert.deepEqual(copied, [path])
    assert.equal(fixture.vm.feedback, '✓ 已复制')
    assert.equal(fixture.vm.copying, false)
    await fixture.render('')
    assert.equal(fixture.vm.available, false)
    assert.equal(fixture.vm.feedback, '')
    await fixture.vm.copyPath()
    assert.deepEqual(copied, [path])
})

test('path component reports an actionable inline error instead of false success', async t => {
    const { replace } = installBrowser(t)
    replace('navigator', { clipboard: { writeText: async () => { throw new Error('permission denied') } } })
    const fixture = await mounted(t)
    await fixture.vm.copyPath()
    assert.equal(fixture.vm.failed, true)
    assert.match(fixture.vm.feedback, /复制失败.*手动复制/)
    assert.equal(fixture.vm.copying, false)
})

test('path success feedback expires after three seconds and duplicate clicks are guarded', async t => {
    const { replace } = installBrowser(t)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = deferred()
    let writes = 0
    replace('navigator', { clipboard: { writeText: async () => { writes++; await pending.promise } } })
    const fixture = await mounted(t)
    const first = fixture.vm.copyPath()
    await fixture.vm.copyPath()
    assert.equal(writes, 1)
    pending.resolve()
    await first
    assert.equal(fixture.vm.feedback, '✓ 已复制')
    t.mock.timers.tick(2999)
    assert.equal(fixture.vm.feedback, '✓ 已复制')
    t.mock.timers.tick(1)
    assert.equal(fixture.vm.feedback, '')
})

test('path template compiles, exposes full path and blocks click/keyboard propagation to model preview rows', () => {
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: componentUrl.pathname, id: 'copy-path-test' }).errors, [])
    assert.match(descriptor.template.content, /@click\.stop="copyPath"/)
    assert.match(descriptor.template.content, /@keydown\.stop/)
    assert.match(descriptor.template.content, /:aria-label="`复制文件路径：\$\{path\}`"/)
    assert.match(descriptor.template.content, /:title="`\$\{path\}/)
    assert.match(descriptor.template.content, /v-if="available"/)
})

function settingsFixture(t) {
    installBrowser(t)
    const previousSession = { ...adminSession }
    Object.assign(adminSession, { authenticated: true, user: { id: 'owner', role: 'owner' }, pagePermissions: normalizePagePermissions(undefined, { owner: true }) })
    t.after(() => Object.assign(adminSession, previousSession))
    const scope = effectScope()
    t.after(() => scope.stop())
    return scope.run(() => useSystemSettings({ alert: async () => {}, confirm: async () => true }))
}

const config = (retentionDays = 30) => ({ autoEnabled: true, intervalHours: 24, mirrorDirectory: '', retentionDays })
const status = (retentionDays = 30, extras = {}) => ({ supported: true, retentionDays, retentionDaysMin: 1, retentionDaysMax: 3650, totalBackupBytes: 123456, localDirectory: 'C:\\灾备', backups: [{ filename: 'fixture.zip', fullPath: 'C:\\灾备\\fixture.zip' }], config: config(retentionDays), ...extras })

test('site status loads paths/space/policy without contaminating the separate automatic-backup config', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getSiteBackups', async () => status(60))
    await settings.loadSiteBackups()
    assert.equal(settings.siteBackupPolicy.retentionDays, 60)
    assert.equal(settings.siteBackupStatus.localDirectory, 'C:\\灾备')
    assert.equal(settings.siteBackupStatus.totalBackupBytes, 123456)
    assert.equal(settings.siteBackupStatus.backups[0].fullPath, 'C:\\灾备\\fixture.zip')
    assert.deepEqual(settings.siteBackupConfig, { autoEnabled: true, intervalHours: 24, mirrorDirectory: '' })
})

test('site status refresh preserves pending automatic-backup and retention drafts', async t => {
    const settings = settingsFixture(t)
    let payload = status(30)
    t.mock.method(adminApi, 'getSiteBackups', async () => payload)
    await settings.loadSiteBackups()
    settings.selectSiteBackupRetention(7)
    settings.siteBackupConfig.mirrorDirectory = 'E:\\外部备份草稿'
    payload = status(90, { totalBackupBytes: 987654, config: { ...config(90), intervalHours: 48 } })
    await settings.loadSiteBackups()
    assert.equal(settings.siteBackupStatus.totalBackupBytes, 987654)
    assert.equal(settings.siteBackupStatus.retentionDays, 90)
    assert.equal(settings.siteBackupPolicy.retentionDays, 7)
    assert.equal(settings.siteBackupConfig.mirrorDirectory, 'E:\\外部备份草稿')
    assert.equal(settings.siteBackupConfig.intervalHours, 24)
})

test('saving site policy sends only retentionDays and does not implicitly save the external-directory draft', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getSiteBackups', async () => status(30))
    await settings.loadSiteBackups()
    settings.siteBackupConfig.mirrorDirectory = 'E:\\尚未保存'
    settings.selectSiteBackupRetention(7)
    const submissions = []
    t.mock.method(adminApi, 'saveSiteBackupConfig', async value => {
        submissions.push({ ...value })
        return { success: true, config: config(7), status: status(7), cleanup: { deletedCount: 2, errors: [] } }
    })
    await settings.saveSiteBackupPolicy()
    assert.deepEqual(submissions, [{ retentionDays: 7 }])
    assert.equal(settings.siteBackupConfig.mirrorDirectory, 'E:\\尚未保存')
    assert.equal(settings.siteBackupPolicy.retentionDays, 7)
    assert.match(settings.siteBackupMessage.value, /已自动清理 2 份过期备份/)
    assert.equal(settings.siteBackupPolicySaving.value, false)
})

test('saving automatic site backup never sends or overwrites an unsaved retention draft', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getSiteBackups', async () => status(30))
    await settings.loadSiteBackups()
    settings.siteBackupConfig.mirrorDirectory = 'E:\\安全副本'
    settings.selectSiteBackupRetention(7)
    const submissions = []
    t.mock.method(adminApi, 'saveSiteBackupConfig', async value => {
        submissions.push({ ...value })
        return { success: true, config: { ...config(30), mirrorDirectory: value.mirrorDirectory }, status: status(30) }
    })
    await settings.saveSiteBackupConfiguration()
    assert.deepEqual(submissions, [{ autoEnabled: true, intervalHours: 24, mirrorDirectory: 'E:\\安全副本' }])
    assert.equal(settings.siteBackupPolicy.retentionDays, 7)
    assert.equal(settings.siteBackupConfig.mirrorDirectory, 'E:\\安全副本')
})

test('invalid retention input never reaches the backend', async t => {
    const settings = settingsFixture(t)
    let saves = 0
    t.mock.method(adminApi, 'saveSiteBackupConfig', async () => { saves++; return { success: true } })
    for (const value of [0, -1, 1.5, NaN, Infinity, 3651, '']) {
        settings.siteBackupPolicy.retentionDays = value
        await settings.saveSiteBackupPolicy()
        assert.match(settings.siteBackupMessage.value, /1-3650 之间的整数/)
        assert.equal(settings.siteBackupPolicySaving.value, false)
    }
    assert.equal(saves, 0)
})

test('pending site policy blocks factory switching before any silent cleanup call', async t => {
    const settings = settingsFixture(t)
    let saves = 0
    t.mock.method(adminApi, 'saveSiteBackupConfig', async () => { saves++; return { success: true } })
    settings.selectSiteBackupRetention(7)
    await assert.rejects(settings.savePendingSystemSettings(), /整站备份保留策略有未保存修改/)
    assert.equal(saves, 0)
    assert.equal(settings.siteBackupPolicy.retentionDays, 7)
})

test('failed or malformed site responses preserve known files and retention draft', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getSiteBackups', async () => status(30))
    await settings.loadSiteBackups()
    settings.selectSiteBackupRetention(7)
    t.mock.method(adminApi, 'getSiteBackups', async () => ({}))
    await settings.loadSiteBackups()
    assert.equal(settings.siteBackupStatus.backups[0].filename, 'fixture.zip')
    assert.match(settings.siteBackupMessage.value, /读取失败.*响应无效/)
    t.mock.method(adminApi, 'saveSiteBackupConfig', async () => ({ success: false, error: 'disk denied' }))
    await settings.saveSiteBackupPolicy()
    assert.equal(settings.siteBackupStatus.backups[0].filename, 'fixture.zip')
    assert.equal(settings.siteBackupPolicy.retentionDays, 7)
    assert.match(settings.siteBackupMessage.value, /保存失败.*disk denied/)
    assert.equal(settings.siteBackupPolicySaving.value, false)
})

test('typing during a pending policy save preserves the newer draft and overlapping saves are guarded', async t => {
    const settings = settingsFixture(t)
    const pending = deferred()
    let submissions = 0
    t.mock.method(adminApi, 'saveSiteBackupConfig', async () => { submissions++; return pending.promise })
    settings.selectSiteBackupRetention(7)
    const save = settings.saveSiteBackupPolicy()
    await settings.saveSiteBackupPolicy()
    await settings.saveSiteBackupConfiguration()
    assert.equal(submissions, 1)
    settings.selectSiteBackupRetention(14)
    pending.resolve({ success: true, config: config(7), status: status(7), cleanup: { deletedCount: 0, errors: [] } })
    await save
    assert.equal(settings.siteBackupStatus.retentionDays, 7)
    assert.equal(settings.siteBackupPolicy.retentionDays, 14)
    await assert.rejects(settings.savePendingSystemSettings(), /整站备份保留策略有未保存修改/)
})

test('admin uses copy paths for models/database/site files and identical retention metrics in both backup tabs', async () => {
    const admin = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
    assert.match(admin, /<CopyPathButton[^>]*:path="m\.file_path"/)
    assert.match(admin, /<CopyPathButton[^>]*databaseBackupStatus\.directory/)
    assert.match(admin, /<CopyPathButton[^>]*siteBackupStatus\.localDirectory/)
    const site = admin.slice(admin.indexOf('<div class="database-retention-card site-retention-card">'), admin.indexOf('<!-- ===== 运行与投屏 ===== -->'))
    for (const label of ['现有备份', '占用空间', '最早备份', '最新备份']) assert.ok(site.includes(label))
    assert.match(site, /siteBackupStatus\.totalBackupBytes/)
    assert.match(site, /siteBackupPolicy\.retentionDays/)
    assert.match(site, /@click="saveSiteBackupPolicy"/)
    assert.match(site, /@click="selectSiteBackupRetention\(days\)"\s+v-permission="\{ page: controlPermissionPage, action: 'edit' \}"/)
    assert.doesNotMatch(site, /backups\.slice\(0, 3\)/)
})
