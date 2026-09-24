import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.resolve(projectRoot, 'frontend/public/maps/china-admin')
if (!outputRoot.startsWith(path.join(projectRoot, 'frontend', 'public', 'maps') + path.sep)) {
  throw new Error('Refusing to write admin boundaries outside frontend/public/maps')
}

const sourceUrl = 'https://geo.datav.aliyun.com/areas_v3/bound/'
const provinceDir = path.join(outputRoot, 'provinces')
const districtDir = path.join(outputRoot, 'districts')
await Promise.all([mkdir(provinceDir, { recursive: true }), mkdir(districtDir, { recursive: true })])

const china = JSON.parse(await readFile(path.join(projectRoot, 'frontend/public/maps/china-provinces.geojson'), 'utf8'))
const provinces = china.features.filter(feature => /^\d{6}$/.test(String(feature.properties?.adcode || '')))
const queue = []
const failures = []
const unavailableProvinces = []
const queuedDistrictCodes = new Set()
const bytes = { provinces: 0, districts: 0 }

async function load(code) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${sourceUrl}${code}_full.json`, { signal: AbortSignal.timeout(20000) })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = JSON.parse(text)
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('not a GeoJSON FeatureCollection')
      return { data, size: Buffer.byteLength(text) }
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
    }
  }
  throw lastError
}

for (const province of provinces) queue.push({ code: String(province.properties.adcode), kind: 'province' })
let cursor = 0
const workers = Array.from({ length: 10 }, async () => {
  while (cursor < queue.length) {
    const index = cursor++
    const task = queue[index]
    try {
      const { data, size } = await load(task.code)
      if (task.kind === 'province') {
        await writeFile(path.join(provinceDir, `${task.code}.geojson`), JSON.stringify(data))
        bytes.provinces += size
        const children = data.features
          .filter(feature => Number(feature.properties?.childrenNum) > 0)
          .map(feature => String(feature.properties?.adcode || ''))
          .filter(code => /^\d{6}$/.test(code))
        for (const code of children) {
          if (queuedDistrictCodes.has(code)) continue
          queuedDistrictCodes.add(code)
          queue.push({ code, kind: 'district' })
        }
      } else {
        await writeFile(path.join(districtDir, `${task.code}.geojson`), JSON.stringify(data))
        bytes.districts += size
      }
    } catch (error) {
      if (task.kind === 'province' && error.message.includes('HTTP 404')) unavailableProvinces.push(task.code)
      else failures.push(`${task.code}: ${error.message}`)
    }
  }
})
await Promise.all(workers)

const manifest = {
  source: sourceUrl,
  generatedAt: new Date().toISOString(),
  level: 'province -> city -> district/county',
  provinces: provinces.map(feature => ({ code: String(feature.properties.adcode), name: feature.properties.name })),
  unavailableProvinces,
  provinceFiles: provinces.length - unavailableProvinces.length - failures.filter(item => provinces.some(feature => item.startsWith(`${feature.properties.adcode}:`))).length,
  districtFiles: queue.filter(task => task.kind === 'district').length - failures.filter(item => queue.some(task => task.kind === 'district' && item.startsWith(`${task.code}:`))).length,
  bytes,
  failures
}
await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({
  provinceFeatures: manifest.provinces.length,
  provinceFiles: manifest.provinceFiles,
  districtFiles: manifest.districtFiles,
  megabytes: ((bytes.provinces + bytes.districts) / 1048576).toFixed(1),
  unavailableProvinces,
  failures
}, null, 2))
if (failures.length) process.exitCode = 1
