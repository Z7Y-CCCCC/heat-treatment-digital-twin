import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFactoryDistributionPreview } from '../src/runtime/factoryDistributionPreview.js'

test('distribution preview aggregates factories to province centers without inventing coordinates', () => {
  const sites = [
    { id: 'local', name: '天津一厂', location: { country: 'CHN', regionCode: '120000', cityCode: '120100', districtCode: '120101' } },
    { id: 'registered', name: '天津二厂', location: { country: 'CHN', regionCode: '120000' } },
    { id: 'abroad', name: '东京工厂', location: { country: 'JPN' } },
    { id: 'unassigned', location: { country: 'CHN' } }
  ]
  const features = [
    { properties: { adcode: '120000', name: '天津市', centroid: [117.2, 39.1] }, geometry: { type: 'Polygon', coordinates: [[[117, 39], [118, 39], [118, 40], [117, 40], [117, 39]]] } },
    { properties: { adcode: '130000', name: '河北省', centroid: [114.5, 38] }, geometry: { type: 'MultiPolygon', coordinates: [[[[114, 37], [115, 37], [115, 38], [114, 37]]]] } }
  ]

  const world = [
    { properties: { ADM0_A3: 'CHN', NAME_ZH: '中华人民共和国', LABEL_X: 106, LABEL_Y: 35 }, geometry: { type: 'Polygon', coordinates: [[[105, 34], [107, 34], [107, 36], [105, 34]]] } },
    { properties: { ADM0_A3: 'JPN', NAME_ZH: '日本', LABEL_X: 139, LABEL_Y: 36 }, geometry: { type: 'Polygon', coordinates: [[[138, 35], [140, 35], [140, 37], [138, 35]]] } }
  ]
  const preview = buildFactoryDistributionPreview(sites, features, world)
  assert.equal(preview.chinaCount, 3)
  assert.equal(preview.overseasCount, 1)
  assert.deepEqual(preview.overseasRegions, [{ code: 'JPN', count: 1, name: '日本', factoryNames: ['东京工厂'] }])
  assert.equal(preview.unassignedChinaCount, 1)
  assert.equal(preview.markers.length, 1)
  assert.equal(preview.markers[0].code, '120000')
  assert.equal(preview.markers[0].name, '天津市')
  assert.equal(preview.markers[0].count, 2)
  assert.deepEqual(preview.markers[0].factoryNames, ['天津一厂', '天津二厂'])
  assert.equal(preview.worldMarkers.length, 2)
  const chinaWorldMarker = preview.worldMarkers.find(marker => marker.code === 'CHN')
  assert.equal(chinaWorldMarker.name, '中国')
  assert.equal(chinaWorldMarker.count, 3)
  assert.deepEqual(chinaWorldMarker.factoryNames, ['天津一厂', '天津二厂', '未命名工厂'])
  assert.ok(Number.isFinite(chinaWorldMarker.x) && Number.isFinite(chinaWorldMarker.y))
  assert.deepEqual(preview.worldMarkers.find(marker => marker.code === 'JPN').factoryNames, ['东京工厂'])
  assert.equal(preview.worldCountries.length, 2)
  assert.equal(preview.worldCountries.find(country => country.code === 'CHN').populated, true)
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
