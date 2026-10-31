import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelDisplayIds, createShortModelId } from '../src/views/admin/utils/modelIds.js'

test('display codes are compact, deterministic across sorting, and never rewrite source IDs', () => {
  const ids = ['photo_multipurpose_furnace_v6_pipefix', 'pit_furnace_1_v1', '工厂模型-很长的名称-20261031']
  const before = [...ids], normal = buildModelDisplayIds(ids), reversed = buildModelDisplayIds([...ids].reverse())
  assert.deepEqual(normal, reversed); assert.deepEqual(ids, before)
  assert.equal(new Set(normal.values()).size, ids.length)
  for (const value of normal.values()) assert.match(value, /^M-[0-9A-F]{8}$/)
})
test('colliding display prefixes extend consistently; full collisions remain distinguishable', () => {
  const result = buildModelDisplayIds(['b', 'a', 'c'], id => ({ a: '12345678AAAA0000', b: '12345678BBBB0000', c: '0000000000000000' })[id])
  assert.equal(result.get('a'), 'M-12345678AA'); assert.equal(result.get('b'), 'M-12345678BB')
  assert.equal(result.get('c'), 'M-00000000')
  assert.deepEqual([...buildModelDisplayIds(['b', 'a'], () => '0123456789ABCDEF').values()], ['M-0123456789ABCDEF-1', 'M-0123456789ABCDEF-2'])
})
test('new import IDs are short random IDs, independent of file names, and avoid existing IDs', () => {
  let calls = 0
  const random = { getRandomValues: bytes => { bytes.fill(calls++); return bytes } }
  assert.equal(createShortModelId(['m_000000000000'], random), 'm_010101010101')
  assert.equal(calls, 2)
  for (let i = 0; i < 10; i++) assert.match(createShortModelId(), /^m_[0-9a-f]{12}$/)
  assert.throws(() => createShortModelId(['m_000000000000'], { getRandomValues: bytes => bytes }), /无法生成/)
})
