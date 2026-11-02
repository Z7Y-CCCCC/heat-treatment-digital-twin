// Local SVG UI assets. Upstream logo paths are inert data, never executable code.
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'frontend/public/images/data-sources');
const upstream = { mysql: 'mysql', postgres: 'postgresql', mqtt: 'mqtt', redis: 'redis', mongodb: 'mongodb', influxdb: 'influxdb', hikvision: 'hikvision', oracle: 'oracle', s7: 'siemens', iotdb: 'apacheiotdb' };
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
(async () => {
    const { DATA_SOURCE_CATALOG } = await import(pathToFileURL(path.join(root, 'frontend/src/views/admin/utils/dataSourceCatalog.js')).href);
    fs.mkdirSync(output, { recursive: true });
    const provenance = [];
    for (const entry of DATA_SOURCE_CATALOG) {
        let glyph = '', source = '';
        if (upstream[entry.key]) {
            source = `https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/${upstream[entry.key]}.svg`;
            const response = await fetch(source, { signal: AbortSignal.timeout(15000) }).catch(() => null);
            const svg = response?.ok ? await response.text() : '';
            const paths = [...svg.matchAll(/<path\s[^>]*d="([^"]+)"/g)].map(match => match[1]).filter(d => /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(d));
            if (paths.length) glyph = `<g transform="translate(22 33) scale(2.1)" fill="white">${paths.map(d => `<path d="${d}"/>`).join('')}</g>`;
            else source = '';
        }
        if (!glyph) {
            if (['database', 'nosql'].includes(entry.group)) glyph = '<g stroke="white" stroke-width="3" fill="none"><ellipse cx="47" cy="36" rx="21" ry="8"/><path d="M26 36v34c0 10 42 10 42 0V36M26 48c0 10 42 10 42 0M26 60c0 10 42 10 42 0"/></g>';
            else if (entry.group === 'industrial') glyph = '<g stroke="white" stroke-width="3" fill="none"><rect x="25" y="28" width="44" height="49" rx="5"/><path d="M30 40h34M34 48h6m6 0h6m6 0h6M34 57h6m6 0h6m6 0h6M34 66h6m6 0h6m6 0h6M32 23v5m12-5v5m12-5v5m-24 49v6m12-6v6m12-6v6"/></g>';
            else if (entry.group === 'file') glyph = '<g stroke="white" stroke-width="3" fill="none"><path d="M28 24h28l13 14v43H28zM56 24v14h13M35 49h26M35 59h26M35 69h18"/></g>';
            else glyph = '<g stroke="white" stroke-width="3" fill="none"><circle cx="29" cy="51" r="6"/><circle cx="66" cy="51" r="6"/><path d="M36 44h22l-6-6m6 20H36l6 6M35 25c21 0 36 12 36 29M26 81c-8-15-8-32 0-45"/></g>';
        }
        const title = entry.key === 's7' ? 'SIEMENS' : entry.name.replace(' / MariaDB', '').replace(' / REST', '');
        const fontSize = title.length > 11 ? 17 : title.length > 8 ? 20 : 25;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 110" role="img" aria-label="${xml(entry.name)}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${entry.color}"/><stop offset="1" stop-color="${entry.color}" stop-opacity=".85"/></linearGradient></defs><rect width="240" height="110" fill="url(#g)"/><circle cx="216" cy="0" r="91" fill="white" opacity=".06"/><circle cx="240" cy="120" r="80" fill="white" opacity=".04"/>${glyph}<text x="155" y="62" font-family="Segoe UI,Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="white" text-anchor="middle">${xml(title)}</text><path d="M100 78h109" stroke="white" opacity=".25"/></svg>`;
        fs.writeFileSync(path.join(output, entry.key + '.svg'), svg);
        provenance.push({ key: entry.key, file: entry.key + '.svg', source: source || 'Project-authored protocol pictogram / word label', license: source ? 'Simple Icons CC0; brand trademark rights remain with their owners' : 'Project source license' });
    }
    fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
    console.log(`Generated ${provenance.length} local SVG tiles; no runtime CDN requests.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
