const assert = require('node:assert/strict');
const { searchFactoryPlace, parseResults } = require('../services/factoryGeocoder');

async function main() {
    assert.deepEqual(parseResults([
        { display_name: 'Seoul, South Korea', lat: '37.56', lon: '126.98', address: { country_code: 'kr', state: 'Seoul', city: 'Seoul', borough: 'Jongno-gu' } },
        { display_name: 'Wrong country', lat: '35', lon: '139', address: { country_code: 'jp' } },
        { display_name: 'Bad coordinate', lat: '200', lon: '126', address: { country_code: 'kr' } }
    ], 'KR'), [{ displayName: 'Seoul, South Korea', regionName: 'Seoul', city: 'Seoul', districtName: 'Jongno-gu', latitude: 37.56, longitude: 126.98 }]);
    let calls = 0;
    const fakeFetch = async (url, options) => {
        calls++;
        assert.equal(url.hostname, 'nominatim.openstreetmap.org');
        assert.equal(url.searchParams.get('countrycodes'), 'kr');
        assert.equal(url.searchParams.get('addressdetails'), '1');
        assert.ok(options.headers['User-Agent'].includes('HeatTreatmentDigitalTwin'));
        return { ok: true, json: async () => [{ display_name: 'Seoul', lat: '37.56', lon: '126.98', address: { country_code: 'kr', state: 'Seoul', city: 'Seoul' } }] };
    };
    const first = await searchFactoryPlace('KR', 'Seoul factory district', fakeFetch);
    const second = await searchFactoryPlace('KR', 'Seoul factory district', fakeFetch);
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    await assert.rejects(() => searchFactoryPlace('ZZZ', 'Seoul', fakeFetch), /请选择海外国家/);
    console.log('factory geocoder tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
