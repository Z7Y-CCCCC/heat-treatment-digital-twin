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
      label: String(query[`${name}Name`] || (level === name ? currentLabel : '') || (name === 'country' ? COUNTRY_LABELS[code] : '') || code),
      level: name,
      code
    })
    if (name === level) break
  }

  return crumbs
}

export function createGroupHierarchyPath({ scope = 'china', fromGroup = '', embedded = '', location = {}, factoryName = '', query = {} } = {}) {
  const normalizedScope = scope === 'world' ? 'world' : 'china'
  const regionCode = String(fromGroup || '')
  const factoryLocation = parseSpatialObject(location)
  const rootQuery = { ...(embedded ? { embedded } : {}), scope: normalizedScope }
  const trail = [{
    key: 'group',
    label: normalizedScope === 'world' ? '全球分布' : '全国分布',
    to: { path: '/group', query: rootQuery }
  }]

  const country = String(query.country || factoryLocation.country || (normalizedScope === 'china' ? 'CHN' : ''))
  const province = String(query.province || factoryLocation.regionCode || '')
  const city = String(query.city || factoryLocation.cityCode || '')
  const district = String(query.district || factoryLocation.districtCode || '')
  const mapQuery = {
    country,
    countryName: String(query.countryName || COUNTRY_LABELS[country] || factoryLocation.countryName || country),
    province,
    provinceName: String(query.provinceName || factoryLocation.regionName || province),
    city,
    cityName: String(query.cityName || factoryLocation.city || city),
    district,
    districtName: String(query.districtName || factoryLocation.districtName || district)
  }
  const deepest = district ? 'district' : city ? 'city' : province ? 'province' : country && normalizedScope === 'world' ? 'country' : ''
  const resolvedFromGroup = normalizedScope === 'world'
    ? [country, province, city, district].includes(regionCode)
    : [province, city, district].includes(regionCode)
  if (deepest && (deepest === 'country' || /^\d{6}$/.test(province)) && (!regionCode || resolvedFromGroup)) {
    const mapCrumbs = createGroupNavigationCrumbs({ query: mapQuery, level: deepest, currentLabel: mapQuery[`${deepest}Name`] })
    const pathQuery = normalizedScope === 'china'
      ? { ...rootQuery, country, countryName: mapQuery.countryName }
      : { ...rootQuery }
    for (const crumb of mapCrumbs.slice(1)) {
      if (normalizedScope === 'china' && crumb.level === 'country') continue
      pathQuery[crumb.level] = crumb.code
      pathQuery[`${crumb.level}Name`] = crumb.label
      if (crumb.level === 'district' && MUNICIPALITY_CODES.has(province) && city === province) {
        pathQuery.city = city
        pathQuery.cityName = mapQuery.cityName
      }
      trail.push({
        key: crumb.key,
        label: crumb.label,
        to: { path: '/group', query: { ...pathQuery, level: crumb.level, code: crumb.code } }
      })
    }
  } else if (regionCode) {
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
