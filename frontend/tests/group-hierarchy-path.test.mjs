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
    ['world', '全球'], ['country', '中国'], ['province', '510000'], ['city', '成都市']
  ])
})

test('legacy overseas country routes retain a parent for Escape navigation', () => {
  const crumbs = createGroupNavigationCrumbs({
    query: { scope: 'world', region: 'KOR' }, level: 'country', currentLabel: '大韩民国'
  })
  assert.deepEqual(crumbs.map(({ level, code, label }) => [level, code, label]), [
    ['world', '', '全球'], ['country', 'KOR', '大韩民国']
  ])
  assert.equal(crumbs.at(-2).level, 'world')
})

test('legacy China province routes can step back to the country map', () => {
  const crumbs = createGroupNavigationCrumbs({
    query: { region: '120000' }, level: 'province', currentLabel: '天津市'
  })
  assert.deepEqual(crumbs.map(({ level, code }) => [level, code]), [
    ['world', ''], ['country', 'CHN'], ['province', '120000']
  ])
  assert.equal(crumbs.at(-2).level, 'country')
})

test('workshop overlay resolves district code to named clickable municipality levels', () => {
  const trail = createGroupHierarchyPath({
    scope: 'china', fromGroup: '120101', embedded: 'unity',
    location: { country:'CHN', regionCode:'120000', regionName:'天津市', cityCode:'120000', city:'天津市', districtCode:'120101', districtName:'和平区' },
    factoryName: '热处理工厂'
  })
  assert.deepEqual(trail.map(({key,label}) => [key,label]), [
    ['group','全国分布'], ['province','天津市'], ['district','和平区'], ['factory','热处理工厂']
  ])
  assert.deepEqual(trail[2].to.query, {
    embedded:'unity', scope:'china', country:'CHN', countryName:'中国',
    province:'120000', provinceName:'天津市', city:'120000', cityName:'天津市',
    district:'120101', districtName:'和平区', level:'district', code:'120101'
  })
})

test('workshop overlay keeps normal province, city and district navigation', () => {
  const trail = createGroupHierarchyPath({
    scope:'world', fromGroup:'510102',
    query:{country:'CHN',countryName:'中华人民共和国',province:'510000',provinceName:'四川省',city:'510100',cityName:'成都市',district:'510102',districtName:'锦江区'},
    factoryName:'成都工厂'
  })
  assert.deepEqual(trail.map(({label}) => label), ['全球分布','中华人民共和国','四川省','成都市','锦江区','成都工厂'])
  assert.equal(trail[3].to.query.level,'city')
  assert.equal(trail[3].to.query.code,'510100')
})
