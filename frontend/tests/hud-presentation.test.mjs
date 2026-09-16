import test from 'node:test'
import assert from 'node:assert/strict'
import { fitHudCanvas, splitHudKpiValue } from '../src/runtime/hudPresentation.js'

test('reference typography and charts scale together at all delivery sizes', () => {
  for (const [width, height, scale] of [[1920,1080,1], [1600,900,5/6], [1280,720,2/3]]) {
    const style = fitHudCanvas({ width: 1920, height: 1080 }, { width, height })
    assert.equal(style.width, '1920px')
    assert.equal(style.height, '1080px')
    assert.equal(style.transform, `translate(-50%, -50%) scale(${scale})`)
  }
})

test('window chrome and unusual aspect ratios do not crop the authored canvas', () => {
  const canvas = { width: 1920, height: 1080 }
  const style = fitHudCanvas(canvas, { width: 1600, height: 846 })
  assert.equal(style.transform, `translate(-50%, -50%) scale(${846/1080})`)
  assert.deepEqual(canvas, { width: 1920, height: 1080 })
  assert.equal(fitHudCanvas({ width: Infinity, height: -1 }, { width: 0, height: NaN }).transform, 'translate(-50%, -50%) scale(1)')
})

test('KPI units can be typeset smaller without changing the live value', () => {
  assert.deepEqual(splitHudKpiValue('3,712 kWh'), { value: '3,712', unit: 'kWh' })
  assert.deepEqual(splitHudKpiValue('1,179 件'), { value: '1,179', unit: '件' })
  assert.deepEqual(splitHudKpiValue('92.0%'), { value: '92.0', unit: '%' })
  assert.deepEqual(splitHudKpiValue('--'), { value: '--', unit: '' })
  assert.deepEqual(splitHudKpiValue('等待实时数据'), { value: '等待实时数据', unit: '' })
})
