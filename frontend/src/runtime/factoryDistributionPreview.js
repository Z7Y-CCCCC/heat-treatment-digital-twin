const MAP_BOUNDS = { west: 73, east: 135, south: 17, north: 55 }
const MAP_WIDTH = 320
const MAP_HEIGHT = 220
const MAP_PADDING = 8

function projectCoordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null
  const longitude = Number(value[0]), latitude = Number(value[1])
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return [
    MAP_PADDING + (longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west) * (MAP_WIDTH - MAP_PADDING * 2),
    MAP_PADDING + (MAP_BOUNDS.north - latitude) / (MAP_BOUNDS.north - MAP_BOUNDS.south) * (MAP_HEIGHT - MAP_PADDING * 2)
  ]
}

function ringPath(ring) {
  const points = (Array.isArray(ring) ? ring : []).map(projectCoordinate).filter(Boolean)
  if (points.length < 3) return ''
  return `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`
}

function featurePath(feature) {
  const geometry = feature?.geometry
  if (geometry?.type === 'Polygon') return geometry.coordinates.map(ringPath).filter(Boolean).join('')
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flatMap(polygon => polygon.map(ringPath)).filter(Boolean).join('')
  return ''
}

function featureCenter(feature) {
  const center = feature?.properties?.centroid || feature?.properties?.center
  if (Array.isArray(center)) return projectCoordinate(center)
  return null
}

export function buildFactoryDistributionPreview(sites = [], features = []) {
  const chinaSites = sites.filter(site => site?.location?.country === 'CHN')
  const provinceCounts = new Map()
  let unassignedChinaCount = 0
  for (const site of chinaSites) {
    const code = String(site.location.regionCode || '')
    if (!/^\d{6}$/.test(code)) {
      unassignedChinaCount++
      continue
    }
    provinceCounts.set(code, (provinceCounts.get(code) || 0) + 1)
  }

  const provinces = (Array.isArray(features) ? features : []).flatMap(feature => {
    const code = String(feature?.properties?.adcode || '')
    const path = featurePath(feature)
    if (!code || !path) return []
    const center = featureCenter(feature)
    const count = provinceCounts.get(code) || 0
    return [{ code, name: String(feature.properties?.name || code), path, count, center }]
  })
  const markers = provinces.filter(row => row.count > 0 && row.center).map(row => ({
    code: row.code, name: row.name, count: row.count, x: row.center[0], y: row.center[1]
  }))
  const regions = markers.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  const overseasCounts = new Map()
  for (const site of sites) {
    const country = String(site?.location?.country || '')
    if (country && country !== 'CHN') overseasCounts.set(country, (overseasCounts.get(country) || 0) + 1)
  }
  return {
    provinces,
    markers,
    regions,
    overseasRegions: [...overseasCounts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    chinaCount: chinaSites.length,
    overseasCount: sites.filter(site => site?.location?.country && site.location.country !== 'CHN').length,
    unassignedChinaCount
  }
}
