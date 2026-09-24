import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFactoryDistributionPreview } from '../src/runtime/factoryDistributionPreview.js'

test('distribution preview aggregates factories to province centers without inventing coordinates', () => {
  const sites = [
    { id: 'local', location: { country: 'CHN', regionCode: '120000', cityCode: '120100', districtCode: '120101' } },
    { id: 'registered', location: { country: 'CHN', regionCode: '120000' } },
    { id: 'abroad', location: { country: 'JPN' } },
    { id: 'unassigned', location: { country: 'CHN' } }
  ]
  const features = [
    { properties: { adcode: '120000', name: '天津市', centroid: [117.2, 39.1] }, geometry: { type: 'Polygon', coordinates: [[[117, 39], [118, 39], [118, 40], [117, 40], [117, 39]]] } },
    { properties: { adcode: '130000', name: '河北省', centroid: [114.5, 38] }, geometry: { type: 'MultiPolygon', coordinates: [[[[114, 37], [115, 37], [115, 38], [114, 37]]]] } }
  ]

  const preview = buildFactoryDistributionPreview(sites, features)
  assert.equal(preview.chinaCount, 3)
  assert.equal(preview.overseasCount, 1)
  assert.deepEqual(preview.overseasRegions, [{ code: 'JPN', count: 1 }])
  assert.equal(preview.unassignedChinaCount, 1)
  assert.equal(preview.markers.length, 1)
  assert.equal(preview.markers[0].code, '120000')
  assert.equal(preview.markers[0].name, '天津市')
  assert.equal(preview.markers[0].count, 2)
  assert.ok(Math.abs(preview.markers[0].x - 224.72) < 0.01)
  assert.ok(Math.abs(preview.markers[0].y - 93.36) < 0.01)
  assert.equal(preview.provinces.find(row => row.code === '120000').path.startsWith('M'), true)
  assert.equal('longitude' in sites[0].location, false)
})

test('malformed features and unlocated factories do not break the lightweight preview', () => {
  const preview = buildFactoryDistributionPreview([
    { location: { country: 'CHN' } },
    { location: { country: 'USA' } }
  ], [null, { properties: { name: '无代码区域' }, geometry: { type: 'Point', coordinates: [0, 0] } }])
  assert.equal(preview.provinces.length, 0)
  assert.equal(preview.markers.length, 0)
  assert.equal(preview.unassignedChinaCount, 1)
  assert.equal(preview.overseasCount, 1)
})
