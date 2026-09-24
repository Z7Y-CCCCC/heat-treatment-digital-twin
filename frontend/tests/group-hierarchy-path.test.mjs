import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupHierarchyPath, createGroupNavigationCrumbs } from '../src/runtime/groupHierarchyPath.js'

test('factory hierarchy returns to its actual China region inside the same embedded WebView', () => {
  const trail = createGroupHierarchyPath({
    scope: 'china',
    fromGroup: '31',
    embedded: 'unity',
    location: JSON.stringify({ regionCode: '31', regionName: '上海市' }),
    factoryName: '热处理工厂'
  })

  assert.deepEqual(trail.map(({ key, label }) => ({ key, label })), [
    { key: 'group', label: '全国分布' },
    { key: 'region', label: '上海市' },
    { key: 'factory', label: '热处理工厂' }
  ])
  assert.deepEqual(trail[0].to, { path: '/group', query: { embedded: 'unity', scope: 'china' } })
  assert.deepEqual(trail[1].to, { path: '/group', query: { embedded: 'unity', scope: 'china', region: '31' } })
})

test('unlocated factories keep an honest unassigned-region breadcrumb', () => {
  const trail = createGroupHierarchyPath({ fromGroup: 'unassigned', embedded: 'unity' })
  assert.equal(trail[1].label, '待定位区域')
  assert.equal(trail[1].to.query.region, 'unassigned')
})

test('world breadcrumbs use configured country names or retain the real country code', () => {
  const known = createGroupHierarchyPath({ scope: 'world', fromGroup: 'CHN' })
  const other = createGroupHierarchyPath({ scope: 'world', fromGroup: 'NZL', location: { countryName: 'New Zealand' } })
  assert.equal(known[0].label, '全球分布')
  assert.equal(known[1].label, '中国')
  assert.equal(other[1].label, 'New Zealand')
})

test('direct factory entry still has a group overview parent without inventing a region', () => {
  const trail = createGroupHierarchyPath({ scope: 'world', factoryName: '现场 A' })
  assert.deepEqual(trail.map(({ key }) => key), ['group', 'factory'])
  assert.deepEqual(trail[0].to.query, { scope: 'world' })
})

test('municipality breadcrumbs omit the internal city alias and keep district navigation', () => {
  const crumbs = createGroupNavigationCrumbs({
    query: {
      country: 'CHN', countryName: '中华人民共和国',
      province: '120000', provinceName: '天津市',
      city: '120000', cityName: '天津市',
      district: '120101', districtName: '和平区'
    },
    level: 'district',
    currentLabel: '和平区'
  })

  assert.deepEqual(crumbs.map(({ key, label, level, code }) => ({ key, label, level, code })), [
    { key: 'world', label: '全球', level: 'world', code: '' },
    { key: 'country', label: '中华人民共和国', level: 'country', code: 'CHN' },
    { key: 'province', label: '天津市', level: 'province', code: '120000' },
    { key: 'district', label: '和平区', level: 'district', code: '120101' }
  ])
})

test('ordinary city breadcrumbs remain a distinct level beneath their province', () => {
  const crumbs = createGroupNavigationCrumbs({
    query: { country: 'CHN', province: '510000', city: '510100', cityName: '成都市' },
    level: 'city',
    currentLabel: '成都市'
  })

  assert.deepEqual(crumbs.map(({ level, label }) => [level, label]), [
    ['world', '全球'], ['country', 'CHN'], ['province', '510000'], ['city', '成都市']
  ])
})
