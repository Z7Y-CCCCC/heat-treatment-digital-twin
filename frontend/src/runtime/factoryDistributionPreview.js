const MAP_BOUNDS = { west: 73, east: 135, south: 17, north: 55 }
const MAP_WIDTH = 320
const MAP_HEIGHT = 220
const MAP_PADDING = 8

function projectCoordinate(value, bounds = MAP_BOUNDS) {
  if (!Array.isArray(value) || value.length < 2) return null
  const longitude = Number(value[0]), latitude = Number(value[1])
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return [
    MAP_PADDING + (longitude - bounds.west) / (bounds.east - bounds.west) * (MAP_WIDTH - MAP_PADDING * 2),
    MAP_PADDING + (bounds.north - latitude) / (bounds.north - bounds.south) * (MAP_HEIGHT - MAP_PADDING * 2)
  ]
}

function ringPath(ring, bounds) {
  const points = (Array.isArray(ring) ? ring : []).map(value => projectCoordinate(value, bounds)).filter(Boolean)
  if (points.length < 3) return ''
  return `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`
}

function featurePath(feature, bounds = MAP_BOUNDS) {
  const geometry = feature?.geometry
  if (geometry?.type === 'Polygon') return geometry.coordinates.map(ring => ringPath(ring, bounds)).filter(Boolean).join('')
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flatMap(polygon => polygon.map(ring => ringPath(ring, bounds))).filter(Boolean).join('')
  return ''
}

function featureCenter(feature) {
  const center = feature?.properties?.centroid || feature?.properties?.center
  if (Array.isArray(center)) return projectCoordinate(center)
  return null
}

export function buildFactoryDistributionPreview(sites = [], features = [], worldFeatures = []) {
  const chinaSites = sites.filter(site => site?.location?.country === 'CHN')
  const provinceSites = new Map()
  let unassignedChinaCount = 0
  for (const site of chinaSites) {
    const code = String(site.location.regionCode || '')
    if (!/^\d{6}$/.test(code)) {
      unassignedChinaCount++
      continue
    }
    if (!provinceSites.has(code)) provinceSites.set(code, [])
    provinceSites.get(code).push(site)
  }

  const provinces = (Array.isArray(features) ? features : []).flatMap(feature => {
    const code = String(feature?.properties?.adcode || '')
    const path = featurePath(feature)
    if (!code || !path) return []
    const center = featureCenter(feature)
    const count = provinceSites.get(code)?.length || 0
    return [{ code, name: String(feature.properties?.name || code), path, count, center }]
  })
  const markers = provinces.filter(row => row.count > 0 && row.center).map(row => ({
    code: row.code, name: row.name, count: row.count, x: row.center[0], y: row.center[1],
    factoryNames: provinceSites.get(row.code).map(site => site.name || '未命名工厂')
  }))
  const regions = markers.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  const countrySites = new Map()
  for (const site of sites) {
    const country = String(site?.location?.country || '')
    if (!country) continue
    if (!countrySites.has(country)) countrySites.set(country, [])
    countrySites.get(country).push(site)
  }
  const worldBounds = { west: -180, east: 180, south: -60, north: 85 }
  const worldCountries = (Array.isArray(worldFeatures) ? worldFeatures : []).flatMap(feature => {
    const code = String(feature?.properties?.ADM0_A3 || '')
    const path = featurePath(feature, worldBounds)
    return code && path ? [{ code, path, populated: countrySites.has(code) }] : []
  })
  const worldMarkers = [...countrySites.entries()].flatMap(([code, factories]) => {
    const feature = worldFeatures.find(item => item?.properties?.ADM0_A3 === code)
    const longitude = Number(feature?.properties?.LABEL_X), latitude = Number(feature?.properties?.LABEL_Y)
    const center = Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null
    if (!center) return []
    const [x, y] = projectCoordinate(center, worldBounds)
    return [{ code, name: code === 'CHN' ? '中国' : String(feature.properties.NAME_ZH || feature.properties.ADMIN || code), count: factories.length, x, y,
      factoryNames: factories.map(site => site.name || '未命名工厂') }]
  })
  return {
    provinces,
    markers,
    regions,
    worldCountries,
    worldMarkers,
    overseasRegions: [...countrySites.entries()].filter(([code]) => code !== 'CHN').map(([code, factories]) => ({ code, count: factories.length,
      name: worldMarkers.find(marker => marker.code === code)?.name || code,
      factoryNames: factories.map(site => site.name || '未命名工厂') })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    chinaCount: chinaSites.length,
    overseasCount: sites.filter(site => site?.location?.country && site.location.country !== 'CHN').length,
    unassignedChinaCount
  }
}
