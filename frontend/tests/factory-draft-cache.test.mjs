import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import { cacheFactoryDraft, clearFactoryDraft, discardFactoryDrafts, listFactoryDrafts, readFactoryDraft, saveFactoryDrafts } from '../src/runtime/factoryDraftCache.js'

test('factory drafts are isolated and detached from editor objects', () => {
  const payload = reactive({ value: { title: 'before' } })
  cacheFactoryDraft('one', 'map', 'setting', payload)
  payload.value.title = 'after'
  assert.equal(readFactoryDraft('one', 'map').value.title, 'before')
  const readBack = readFactoryDraft('one', 'map')
  readBack.value.title = 'changed again'
  assert.equal(readFactoryDraft('one', 'map').value.title, 'before')
  assert.equal(readFactoryDraft('two', 'map'), null)
  discardFactoryDrafts('one')
})

test('save-all stops on failure, keeps unsaved drafts and never touches another factory', async () => {
  cacheFactoryDraft('one', 'a', 'setting', { value: 1 })
  cacheFactoryDraft('one', 'b', 'setting', { value: 2 })
  cacheFactoryDraft('two', 'c', 'setting', { value: 3 })
  await assert.rejects(saveFactoryDrafts('one', { setting: async payload => {
    if (payload.value === 2) throw new Error('save failed')
  } }), /save failed/)
  assert.deepEqual(listFactoryDrafts('one').map(item => item.editorId), ['b'])
  assert.deepEqual(listFactoryDrafts('two').map(item => item.editorId), ['c'])
  clearFactoryDraft('one', 'b')
  discardFactoryDrafts('two')
})
