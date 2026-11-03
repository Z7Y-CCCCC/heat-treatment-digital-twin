import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SceneManager } from '../src/three/SceneManager.js'

test('composer suppresses the complete CSS label layer locally, including camera/quality refreshes', async () => {
  const source=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
  const composer=source.slice(source.indexOf('async function renderComposerPreview()'),source.indexOf('async function renderComposerPreview()')+4000)
  assert.match(composer,/deviceLabelConfig: \{ enabled: false \}/)
  assert.match(composer,/labelLayer: false/)
  let renders=0
  const scene={renderOptions:{labelLayer:false},labelRenderer:{render(){renders++}},scene:{},camera:{}}
  SceneManager.prototype.renderLabelLayerOnce.call(scene)
  assert.equal(renders,0)
  scene.renderOptions={}
  SceneManager.prototype.renderLabelLayerOnce.call(scene)
  assert.equal(renders,1,'other previews keep their normal labels by default')
})
