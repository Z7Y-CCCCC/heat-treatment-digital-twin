const cache = new Map();
let nextRequestAt = 0;
let queue = Promise.resolve();

function parseResults(rows, countryCode) {
    return (Array.isArray(rows) ? rows : []).flatMap(row => {
        const address = row?.address || {};
        if (String(address.country_code || '').toLowerCase() !== countryCode.toLowerCase()) return [];
        const latitude = Number(row.lat), longitude = Number(row.lon);
        if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return [];
        return [{
            displayName: String(row.display_name || '').slice(0, 300),
            regionName: String(address.state || address.province || address.region || address.city || address.municipality || address.county || address.state_district || '').slice(0, 100),
            city: String(address.city || address.town || address.village || address.municipality || '').slice(0, 200),
            districtName: String(address.county || address.state_district || address.city_district || address.borough || address.suburb || '').slice(0, 100),
            latitude, longitude
        }];
    }).slice(0, 5);
}

async function searchFactoryPlace(countryCode, query, fetchImpl = globalThis.fetch) {
    const code = String(countryCode || '').trim().toLowerCase();
    const term = String(query || '').trim();
    if (!/^[a-z]{2}$/.test(code) || term.length < 3 || term.length > 160) throw new Error('请选择海外国家并输入 3–160 字的地点');
    const key = `${code}:${term.toLocaleLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const work = queue.catch(() => {}).then(async () => {
        if (cache.has(key)) return cache.get(key);
        const wait = Math.max(0, nextRequestAt - Date.now());
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        nextRequestAt = Date.now() + 1100;
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('q', term);
        url.searchParams.set('countrycodes', code);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('addressdetails', '1');
        url.searchParams.set('limit', '5');
        const response = await fetchImpl(url, {
            headers: { 'User-Agent': 'HeatTreatmentDigitalTwin/1.0 (factory location lookup)', 'Accept': 'application/json' },
            signal: AbortSignal.timeout(9000)
        });
        if (!response.ok) throw new Error(`地点查询暂不可用（${response.status}）`);
        const results = parseResults(await response.json(), code);
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, results);
        return results;
    });
    queue = work.catch(() => {});
    return work;
}

module.exports = { searchFactoryPlace, parseResults };
