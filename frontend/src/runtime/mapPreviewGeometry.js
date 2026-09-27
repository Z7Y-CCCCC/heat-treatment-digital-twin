export function mapPreviewUrls(level, location = {}) {
    if (level === 'world') return ['/maps/world-countries.geojson']
    if (location.country && location.country !== 'CHN') return ['/maps/world-countries.geojson']
    if (level === 'country') return ['/maps/china-provinces.geojson']
    const province = /^\d{6}$/.test(String(location.regionCode || '')) ? String(location.regionCode) : ''
    const city = /^\d{6}$/.test(String(location.cityCode || '')) ? String(location.cityCode) : ''
    if (level === 'province' && province) return [`/maps/china-admin/provinces/${province}.geojson`, '/maps/china-provinces.geojson']
    if ((level === 'city' || level === 'district') && city) return [`/maps/china-admin/districts/${city}.geojson`, ...(province ? [`/maps/china-admin/provinces/${province}.geojson`] : []), '/maps/china-provinces.geojson']
    if (province) return [`/maps/china-admin/provinces/${province}.geojson`, '/maps/china-provinces.geojson']
    return ['/maps/china-provinces.geojson']
}

function outerRings(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return []
    if (geometry.type === 'Polygon') return geometry.coordinates[0] ? [geometry.coordinates[0]] : []
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon?.[0]).filter(Boolean)
    return []
}

export function mapPreviewShapes(geojson, selectedCode = '') {
    const features = Array.isArray(geojson?.features) ? geojson.features : []
    const entries = features.map((feature, index) => ({
        id: String(feature.properties?.adcode || feature.properties?.ADM0_A3 || index),
        rings: outerRings(feature.geometry)
    })).filter(entry => entry.rings.length)
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const entry of entries) for (const ring of entry.rings) for (const point of ring) {
        const lon = Number(point?.[0]), lat = Number(point?.[1])
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return []
    const width = Math.max(.001, maxLon - minLon), height = Math.max(.001, maxLat - minLat)
    const scale = Math.min(910 / width, 470 / height)
    const offsetX = (1000 - width * scale) / 2, offsetY = (560 - height * scale) / 2
    const pointString = point => `${Math.round((point[0] - minLon) * scale + offsetX)},${Math.round((maxLat - point[1]) * scale + offsetY)}`
    return entries.map(entry => ({
        id: entry.id,
        selected: Boolean(selectedCode) && entry.id === String(selectedCode),
        d: entry.rings.map(ring => {
            const step = Math.max(1, Math.ceil(ring.length / 700))
            const sampled = ring.filter((_, index) => index % step === 0)
            if (sampled.at(-1) !== ring.at(-1)) sampled.push(ring.at(-1))
            return sampled.length >= 3 ? `M${sampled.map(pointString).join('L')}Z` : ''
        }).join('')
    })).filter(entry => entry.d)
}
