import { parseSpatialObject } from '../utils/spatialLayout.js'

const COUNTRY_LABELS = Object.freeze({
  CHN: '中国', CN: '中国', USA: '美国', JPN: '日本', DEU: '德国', GBR: '英国', FRA: '法国', KOR: '韩国'
})
const MUNICIPALITY_CODES = new Set(['110000', '120000', '310000', '500000'])

export function createGroupNavigationCrumbs({ query = {}, level = 'world', currentLabel = '' } = {}) {
  const crumbs = [{ key: 'world', label: '全球', level: 'world', code: '' }]

  for (const name of ['country', 'province', 'city', 'district']) {
    const code = String(query[name] || (level === name ? query.code : '') || '')
    if (!code) break

    // A municipality's districts are stored beneath the province code for
    // map lookup. That internal city=province alias is not a separate level.
    if (name === 'city' && code === String(query.province || '') && MUNICIPALITY_CODES.has(code)) {
      if (level === name) break
      continue
    }

    crumbs.push({
      key: name,
      label: String(query[`${name}Name`] || (level === name ? currentLabel : code)),
      level: name,
      code
    })
    if (name === level) break
  }

  return crumbs
}

export function createGroupHierarchyPath({ scope = 'china', fromGroup = '', embedded = '', location = {}, factoryName = '' } = {}) {
  const normalizedScope = scope === 'world' ? 'world' : 'china'
  const regionCode = String(fromGroup || '')
  const factoryLocation = parseSpatialObject(location)
  const rootQuery = { ...(embedded ? { embedded } : {}), scope: normalizedScope }
  const trail = [{
    key: 'group',
    label: normalizedScope === 'world' ? '全球分布' : '全国分布',
    to: { path: '/group', query: rootQuery }
  }]

  if (regionCode) {
    const regionName = regionCode === 'unassigned'
      ? '待定位区域'
      : normalizedScope === 'world'
        ? COUNTRY_LABELS[regionCode] || factoryLocation.countryName || regionCode
        : String(factoryLocation.regionCode || '') === regionCode
          ? factoryLocation.regionName || regionCode
          : regionCode
    trail.push({
      key: 'region',
      label: regionName,
      to: { path: '/group', query: { ...rootQuery, region: regionCode } }
    })
  }

  trail.push({ key: 'factory', label: factoryName || '全厂总览', mode: 'factory', focus: {} })
  return trail
}
