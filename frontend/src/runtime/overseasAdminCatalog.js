export const OVERSEAS_CATALOG_COUNTRIES = new Set('KOR JPN USA DEU GBR FRA CAN AUS NZL SGP MYS THA VNM IDN IND ARE SAU BRA MEX RUS'.split(' '))

const cache = new Map()
export async function loadOverseasAdminCatalog(country, fetcher = fetch) {
  const code = String(country || '').toUpperCase()
  if (!OVERSEAS_CATALOG_COUNTRIES.has(code)) return null
  if (!cache.has(code)) {
    const request = Promise.resolve().then(async () => {
      const response = await fetcher(`/maps/overseas-admin/${code}.json`)
      if (!response.ok) throw new Error(`${code} 行政区目录不可用`)
      const value = await response.json()
      if (value.country !== code || !Array.isArray(value.states)) throw new Error(`${code} 行政区目录格式错误`)
      return value
    }).catch(error => { cache.delete(code); throw error })
    cache.set(code, request)
  }
  return cache.get(code)
}

export function clearOverseasAdminCatalogCache() { cache.clear() }
