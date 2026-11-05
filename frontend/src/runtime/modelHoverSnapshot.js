import * as THREE from 'three'
import { loadConfiguredGltf, disposeSceneObject } from './ConfiguredFactoryScene.js'
import { resolveBackendAssetUrl } from '../three/ModelFactory.js'

// One short-lived renderer, no animation loop, and at most twelve CPU images.
// Repeated rows never keep their own scene, GLB or WebGL context alive.
const cache = new Map()
let pending = Promise.resolve()
export function previewModelForDevice(device, models) {
  const model = models.find(item => item.id === device.model_type)
  const file = device.model_file || model?.file_path || ''
  return { model, file, name: model?.name || device.model_type || '未设置',
    key: JSON.stringify([device.model_type, file, model?.metadata, model?.updated_at]) }
}
export function modelHoverSnapshot(source, signal) {
  const run = async () => {
    signal.throwIfAborted()
    if (cache.has(source.key)) {
      const image = cache.get(source.key); cache.delete(source.key); cache.set(source.key, image); return image
    }
    let root, renderer
    try {
      if (source.file) {
        const gltf = await loadConfiguredGltf(resolveBackendAssetUrl(source.file), { signal, timeoutMs: 20000 })
        root = gltf.scene || gltf.scenes?.[0]
      }
      else if (['builtin_furnace', 'transfer_cart'].includes(source.model?.id || source.type)) {
        const { createDeviceModel } = await import('../three/ModelFactory.js')
        root = await createDeviceModel({ id: 'hover-preview', model_type: source.model?.id || source.type }, source.model ? [source.model] : [])
      }
      signal.throwIfAborted()
      if (!root || root.userData.modelLoadError) throw new Error('模型不可用')
      root.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(root)
      if (box.isEmpty()) throw new Error('模型为空')
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
      if (![...center, ...size].every(Number.isFinite)) throw new Error('模型尺寸无效')
      const radius = Math.max(size.length() / 2, .01), scene = new THREE.Scene()
      scene.background = new THREE.Color('#edf2f7')
      scene.add(root, new THREE.HemisphereLight(0xffffff, 0x758598, 2.6))
      const light = new THREE.DirectionalLight(0xffffff, 3); light.position.copy(center).add(new THREE.Vector3(radius, radius * 2, radius * 3)); scene.add(light)
      const camera = new THREE.PerspectiveCamera(35, 1.4, radius / 100, radius * 30)
      camera.position.copy(center).add(new THREE.Vector3(1, .65, 1.3).normalize().multiplyScalar(radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.05))
      camera.lookAt(center)
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
      renderer.setSize(420, 300); renderer.setPixelRatio(1)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15
      renderer.render(scene, camera)
      const image = renderer.domElement.toDataURL('image/png')
      signal.throwIfAborted()
      cache.set(source.key, image)
      while (cache.size > 12) cache.delete(cache.keys().next().value)
      return image
    } finally {
      if (root) disposeSceneObject(root)
      renderer?.dispose(); renderer?.forceContextLoss()
    }
  }
  const result = pending.then(run)
  pending = result.catch(() => {})
  return result
}
