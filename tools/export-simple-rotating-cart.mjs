// Exports a normal, opt-in model-library asset. Never registers a builtin,
// modifies a device, or substitutes geometry in an existing scene.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import { GLTFExporter } from '../frontend/node_modules/three/examples/jsm/exporters/GLTFExporter.js'
import { createSimpleRotatingCart } from '../frontend/src/three/simpleRotatingCart.js'

const output = path.resolve(process.argv[2] || 'output/simple-rotating-cart-model')
await fs.mkdir(output, { recursive: true })
// Three's exporter uses the browser FileReader API; the asset has no textures.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.() }) }
  readAsDataURL(blob) { blob.arrayBuffer().then(result => { this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`; this.onloadend?.() }) }
}
const mouth = { position: [0, 1, 2], direction: [0, 0, 1], nodeName: 'Physical shared loading mouth' }
const cart = createSimpleRotatingCart(new T.Box3(new T.Vector3(-1.5, 0, -2), new T.Vector3(1.5, 1, 2)), mouth)
const bytes = await new GLTFExporter().parseAsync(cart.root, { binary: true, onlyVisible: true })
await fs.writeFile(path.join(output, 'simple_rotating_cart_v1.glb'), Buffer.from(bytes))
await fs.writeFile(path.join(output, 'simple_rotating_cart_v1.metadata.json'), JSON.stringify({
  schema_version: 1,
  assetSpec: { version: '1.0.0', device_family: '旋转小车', unit: 'm', notes: '普通可选低模资产，不替换其他设备模型。旋转机构可绑定 __SimpleCartUpper；底盘不旋转。' },
  loadingPorts: { version: 1, inlet: mouth, outlet: mouth },
  optimization: { mode: 'off', mergeStatic: false, instanceRepeated: false, materialEnhancement: 'original' },
  inspection: { enabled: false, parts: [] }
}, null, 2))
console.log(JSON.stringify({ output, bytes: bytes.byteLength, turntableNode: '__SimpleCartUpper' }))
