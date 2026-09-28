// Rebuild the offline overseas cascading selector catalog from the pinned
// Countries States Cities Database snapshot (ODbL-1.0).
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const revision = 'f3ba8b5b16635b0a39593e44f9f20a7a4f941f63'
const supported = 'KOR JPN USA DEU GBR FRA CAN AUS NZL SGP MYS THA VNM IDN IND ARE SAU BRA MEX RUS'.split(' ')
const url = `https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/${revision}/json/countries%2Bstates%2Bcities.json`
const output = fileURLToPath(new URL('../public/maps/overseas-admin/', import.meta.url))
const response = await fetch(url)
if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status}`)
const countries = await response.json()
await mkdir(output, { recursive: true })
for (const iso3 of supported) {
  const country = countries.find(row => row.iso3 === iso3)
  if (!country || !country.states?.length) throw new Error(`Missing administrative divisions for ${iso3}`)
  const states = country.states.map(state => ({
    code: String(state.iso3166_2 || `${country.iso2}-${state.iso2}`),
    name: state.name,
    latitude: Number(state.latitude),
    longitude: Number(state.longitude),
    cities: (state.cities || []).map(city => ({
      id: String(city.id),
      name: city.name,
      latitude: Number(city.latitude),
      longitude: Number(city.longitude)
    }))
  }))
  await writeFile(`${output}${iso3}.json`, JSON.stringify({ country: iso3, states }))
  console.log(`${iso3}: ${states.length} regions, ${states.reduce((sum, state) => sum + state.cities.length, 0)} cities`)
}
