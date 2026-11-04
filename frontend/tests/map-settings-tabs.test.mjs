import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { installBrowser, settle } from './helpers.mjs'

const source = new URL('../src/views/admin/components/GroupPortalSettings.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'map-tabs' }).errors, [])
let code = compileScript(descriptor, { id: 'map-tabs' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const name = match[2]
    code = code.replace(match[0], `from ${JSON.stringify(name.endsWith('.vue') ? 'data:text/javascript,export default {}' : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name))}`)
}
const { default: Settings } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Settings.render = () => null
async function fixture(t, edit = true) {
    const env = installBrowser(t), before = { ...adminSession }
    Object.assign(adminSession, { authenticated: true, user: { role: 'viewer' }, pagePermissions: normalizePagePermissions({ 'platform.map': { view: true, edit } }) })
    env.beforeRestore(() => Object.assign(adminSession, before))
    t.mock.method(adminApi, 'getSettings', async () => ({ group_portal_config: {} }))
    t.mock.method(adminApi, 'getDataSources', async () => ({ connections: [] }))
    t.mock.method(adminApi, 'listFactories', async () => ({ activeFactoryId: 'factory_default' }))
    const writes = t.mock.method(adminApi, 'saveSettings', async () => ({ success: true }))
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = ref(null), app = renderer.createApp({ render: () => h(Settings, { ref: instance }) })
    app.mount({}); env.beforeRestore(() => app.unmount()); await settle()
    return { state: instance.value.$.setupState, exposed: instance.value, writes }
}

test('map settings has no component, source or layout editor and tab changes preserve drafts', async t => {
 const {state,writes}=await fixture(t)
 assert.deepEqual(state.sectionTabs.map(tab=>tab.key),['brand','logo','theme','map'])
 state.form.brandTitle='保留草稿';state.selectedLevel='city';state.sectionBody={scrollTop:100}
 state.selectSection('map');assert.equal(state.activeSection,'map');assert.equal(state.levelSection,true);assert.equal(state.sectionBody.scrollTop,0)
 for(const removed of ['components','data','layout'])state.selectSection(removed)
 assert.equal(state.activeSection,'map');assert.equal(state.form.brandTitle,'保留草稿');assert.equal(state.selectedLevel,'city');assert.equal(writes.mock.callCount(),0)
})

test('resetting map geometry does not erase old component layout or source bindings before designer migration',async t=>{
 const {state}=await fixture(t);state.selectedLevel='city';state.form.levels.city={mapZoom:1.5,mapBase:'#112233',layout:{facts:{x:6,y:22}},dataBindings:{factsFactoryCount:{mode:'http_api',connectionId:'old'}},showFacts:false}
 state.resetLevel();assert.equal(state.form.levels.city.mapZoom,undefined);assert.equal(state.form.levels.city.mapBase,undefined);assert.deepEqual(state.form.levels.city.layout,{facts:{x:6,y:22}});assert.equal(state.form.levels.city.dataBindings.factsFactoryCount.connectionId,'old');assert.equal(state.form.levels.city.showFacts,false)
})

test('saving reveals invalid hidden base-theme inputs and a read-only account cannot save', async t => {
 const {state,writes}=await fixture(t,false);state.selectSection('map');await state.save();assert.equal(writes.mock.callCount(),0)
})
