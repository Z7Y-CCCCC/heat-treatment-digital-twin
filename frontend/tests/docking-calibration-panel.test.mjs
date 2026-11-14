import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ref } from 'vue'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const body = panel.slice(panel.indexOf('async function canOpenDockingCalibration('), panel.indexOf('async function openDeviceLoadingPorts('))
function fixture() {
    const lines = ref([{ id: 'line-a' }, { id: 'line-b' }]), lineDeviceLayoutBusy = ref(false), showDeviceForm = ref(false)
    const savedDeviceLayoutSnapshots = ref({ other: { preserved: true } }), denied = new Set(), dirty = new Set(), calls = []
    const deps = { lines, lineDeviceLayoutBusy, showDeviceForm, savedDeviceLayoutSnapshots,
        canAdminApi: (path, method) => path === '/api/devices/docking-calibration' && method === 'PUT' && !denied.size,
        lineHasUnsavedLayout: line => dirty.has(line.id),
        alert: async (...args) => calls.push(['alert', ...args]),
        patchDeviceLocally: (...args) => calls.push(['patch', ...args]),
        deviceLayoutSnapshot: device => ({ serialized: JSON.stringify(device) }),
        scheduleNativeScenePreview: config => calls.push(['preview', config]) }
    const methods = new Function(...Object.keys(deps), `${body}; return {canOpenDockingCalibration, applySavedDockingCalibration}`)(...Object.values(deps))
    return { ...deps, ...methods, calls, denied, dirty }
}

test('calibration follows the authoritative API permission and refuses unavailable or unsaved lines', async () => {
    const f = fixture()
    assert.equal(await f.canOpenDockingCalibration('line-a'), true)
    f.denied.add('api')
    assert.equal(await f.canOpenDockingCalibration('line-a'), false)
    f.denied.clear()
    assert.deepEqual(f.calls, [], 'lack of permission never opens a dialog or sends a write')
    f.dirty.add('line-a')
    assert.equal(await f.canOpenDockingCalibration('line-a'), false)
    assert.equal(await f.canOpenDockingCalibration('line-b'), true, 'unrelated line drafts stay untouched')
    assert.equal(await f.canOpenDockingCalibration('removed'), false)
    assert.equal(f.calls.filter(call => call[0] === 'alert').length, 2)
})

test('calibration blocks busy saves and the existing device editor', async () => {
    const f = fixture()
    f.lineDeviceLayoutBusy.value = true
    assert.equal(await f.canOpenDockingCalibration('line-a'), false)
    f.lineDeviceLayoutBusy.value = false
    f.showDeviceForm.value = true
    assert.equal(await f.canOpenDockingCalibration('line-a'), false)
    assert.ok(f.calls.every(call => call[0] === 'alert'))
})

test('only confirmed calibration updates that device baseline and schedules the existing Unity sync', () => {
    const f = fixture(), device = { id: 'fixed-a', pos_x: 2, pos_y: .8 }
    for (const response of [null, {}, { success: false, devices: [device] }, { success: true }]) f.applySavedDockingCalibration(response)
    assert.deepEqual(f.calls, [])
    f.applySavedDockingCalibration({ success: true, devices: [device] })
    assert.deepEqual(f.calls, [['patch', device.id, device], ['preview', { source: 'lines', includeLayout: true, deviceOverride: null }]])
    assert.equal(f.savedDeviceLayoutSnapshots.value[device.id].serialized, JSON.stringify(device))
    assert.deepEqual(f.savedDeviceLayoutSnapshots.value.other, { preserved: true })
    assert.match(panel, /:lines="lines" :models="models"[\s\S]*:can-calibrate="canOpenDockingCalibration"[^>]*@calibrated="applySavedDockingCalibration"/)
})
