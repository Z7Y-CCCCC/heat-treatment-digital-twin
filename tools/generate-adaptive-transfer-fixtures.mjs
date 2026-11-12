import {writeFile,mkdir} from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createAdaptiveTransferFixture} from './adaptive-transfer-fixture.mjs'
const {requireTestPath}=createRequire(import.meta.url)('../backend/scripts/integration-test-utils.cjs')
const directory=requireTestPath(path.resolve(process.argv[2]||'output/playwright/adaptive-transfer/final-20261111'))
await mkdir(directory,{recursive:true})
const fixtures=[]
for(const kind of ['single-negative','single-positive','dual'])for(const micro of [0,.25,.5])fixtures.push(await createAdaptiveTransferFixture({kind,micro}))
fixtures.push(await createAdaptiveTransferFixture({kind:'dual',micro:.5,units:10}))
fixtures.push(await createAdaptiveTransferFixture({kind:'single-positive',micro:0,units:.1}))
const noisy=await createAdaptiveTransferFixture({kind:'dual',micro:0,units:.8})
noisy.devices[0].instance_config.movement.sceneUnitsPerMeter=.79999999616123
fixtures.push(noisy)
await writeFile(path.join(directory,'fixtures.json'),JSON.stringify(fixtures,null,2))
console.log(`Prepared ${fixtures.length} isolated actual-CAD fixtures in ${directory}`)
