import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultAccountPagePermissions, withCapabilityPageReads } from '../../shared/accountTemplates.mjs'

test('cast and backup quick settings add only corresponding page reads without mutating saved grants', () => {
  for (const [capability, page] of [['cast', 'settings.runtime'], ['backup', 'settings.database']]) {
    const saved = defaultAccountPagePermissions('customer')
    const result = withCapabilityPageReads(saved, { [capability]: true })
    assert.equal(result[page].view, true)
    assert.equal(result[page].edit, false)
    assert.equal(saved[page].view, false)
    for (const [key, grants] of Object.entries(result)) for (const [action, enabled] of Object.entries(grants)) {
      if (enabled) { assert.equal(action, 'view'); assert.ok([page, 'devices', 'point-monitor'].includes(key)) }
    }
    assert.deepEqual(withCapabilityPageReads(saved, { [capability]: false }), saved)
  }
  const author = { 'settings.runtime': { view: true, edit: true } }
  assert.equal(withCapabilityPageReads(author, { backup: true })['settings.runtime'].edit, true)
})
