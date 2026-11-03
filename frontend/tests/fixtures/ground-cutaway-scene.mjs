import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { IndustrialGroundRenderer } from '../../src/runtime/IndustrialGroundRenderer.js'

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(1280, 700); renderer.setPixelRatio(1); renderer.setClearColor(0xa7b1b0); document.body.append(renderer.domElement)
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1280 / 700, .1, 500), controls = new THREE.EventDispatcher()
scene.add(new THREE.HemisphereLight(0xffffff, 0x65727d, 2.4))
const light = new THREE.DirectionalLight(0xffffff, 2.8); light.position.set(20, 40, 30); scene.add(light)
const modelUrl = new URLSearchParams(location.search).get('model')
const gltf = await new GLTFLoader().loadAsync(modelUrl), original = gltf.scene
const box = new THREE.Box3().setFromObject(original), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
const scale = Math.min(6 / size.x, 6 / size.z)
const devices = Array.from({ length: 9 }, (_, i) => {
  const x = (i - 4) * 9, model = original.clone(true), wrapper = new THREE.Group()
  model.position.set(-center.x, -box.min.y, -center.z); wrapper.add(model); wrapper.scale.setScalar(scale); wrapper.position.set(x, -4, 0); scene.add(wrapper)
  return { id: `pit_${i}`, pos_x: x, pos_y: -4, pos_z: 0, scale: 1, coordinate_space: 'workshop_local', instance_config: { ground: { enabled: true, width: size.x * scale + .4, depth: size.z * scale + .4, clearance: .5 } } }
})
const workshops = [{ id: 'cad-pit-shop', layout: { size: { width: 96, depth: 22 }, ground: { elevation: 0, areas: [] } }, devices }]
const saved = JSON.stringify(workshops), manager = { scene, camera, controls, environmentObjects: [] }
let ground, enabled = false
function render() { camera.updateMatrixWorld(); controls.dispatchEvent({ type: 'change' }); renderer.render(scene, camera) }
function setCamera(side) {
  const points = { front: [0, 1.3, 68], back: [0, 1.3, -68], diagonal: [44, 7, 59], top: [0, 110, .01] }
  camera.position.set(...points[side]); camera.lookAt(0, -1, 0); render()
}
function toggle(value) {
  ground?.dispose(); enabled = value; ground = new IndustrialGroundRenderer(manager, { cutaway: enabled }); ground.update(workshops, true); render()
}
toggle(false); setCamera('front')
window.cutawayTest = {
  setCamera, toggle,
  state: () => ({ enabled, unchanged: JSON.stringify(workshops) === saved, geometries: renderer.info.memory.geometries, triangles: renderer.info.render.triangles,
    modelSize: size.toArray().map(n => n * scale), vertices: ground.floors[0].mesh.geometry.attributes.position.count }),
  orbit: count => { for (let i = 0; i < count; i++) { const angle = i * Math.PI * 2 / count; camera.position.set(Math.sin(angle) * 68, 7, Math.cos(angle) * 68); camera.lookAt(0, -1, 0); ground.updateView(); renderer.render(scene, camera) }; return window.cutawayTest.state() }
}
