import test from 'node:test'
import assert from 'node:assert/strict'
import { useAppDialog } from '../src/views/admin/composables/useAppDialog.js'

test('factory switch dialog distinguishes cancel, discard and save', async () => {
  const dialog = useAppDialog()
  const options = { title: '切换工厂', showCancel: true, secondaryText: '不保存并切换', confirmText: '保存并切换' }
  for (const decision of [false, 'secondary', true]) {
    const pending = dialog.openAppDialog(options)
    assert.equal(dialog.appDialog.secondaryText, '不保存并切换')
    dialog.closeAppDialog(decision)
    assert.equal(await pending, decision)
    assert.equal(dialog.appDialog.visible, false)
  }
  const regular = dialog.openAppDialog({ message: '普通提示' })
  assert.equal(dialog.appDialog.secondaryText, '')
  dialog.closeAppDialog(true)
  await regular
})
