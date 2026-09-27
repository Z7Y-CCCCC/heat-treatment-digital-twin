import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPreviewShapes, mapPreviewUrls } from '../src/runtime/mapPreviewGeometry.js'

test('map designer uses local lightweight outlines for each map level', () => {
  const location = { regionCode: '120000', cityCode: '120000', districtCode: '120101' }
  assert.deepEqual(mapPreviewUrls('world', location), ['/maps/world-countries.geojson'])
  assert.deepEqual(mapPreviewUrls('country', location), ['/maps/china-provinces.geojson'])
  assert.equal(mapPreviewUrls('province', location)[0], '/maps/china-admin/provinces/120000.geojson')
  assert.equal(mapPreviewUrls('city', location)[0], '/maps/china-admin/districts/120000.geojson')
  assert.equal(mapPreviewUrls('district', location)[1], '/maps/china-admin/provinces/120000.geojson')
  assert.deepEqual(mapPreviewUrls('province', { country: 'DEU' }), ['/maps/world-countries.geojson'])
})

test('map outline conversion preserves selected administrative region', () => {
  const shapes = mapPreviewShapes({ features: [
    { properties: { adcode: 120101 }, geometry: { type: 'Polygon', coordinates: [[[117, 39], [118, 39], [118, 40], [117, 39]]] } },
    { properties: { adcode: 120102 }, geometry: { type: 'Polygon', coordinates: [[[118, 39], [119, 39], [119, 40], [118, 39]]] } }
  ] }, '120101')
  assert.equal(shapes.length, 2)
  assert.equal(shapes[0].selected, true)
  assert.equal(shapes[1].selected, false)
  assert.match(shapes[0].d, /^M\d+,\d+L/)
})
