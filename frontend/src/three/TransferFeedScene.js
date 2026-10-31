import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { restoreGltfNodeNames } from './gltfNodeIdentity.js'
import { TRANSFER_MODEL_PROFILES, planFeedPlacement } from './feedSequence.js'

function disposeObject(root) {
    const geometries = new Set(), materials = new Set(), textures = new Set()
    root?.traverse(node => {
        if (node.geometry) geometries.add(node.geometry)
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            if (!material) continue
            materials.add(material)
            for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
        }
    })
    geometries.forEach(value => value.dispose())
    materials.forEach(value => value.dispose())
    textures.forEach(value => value.dispose())
}

export class TransferFeedScene {
    constructor(container, onTick) {
        this.active = true
        this.container = container
        this.scene = new THREE.Scene()
        this.scene.background = new THREE.Color('#eef3f7')
        this.camera = new THREE.PerspectiveCamera(42, 1, .05, 500)
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
        this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5))
        this.renderer.outputColorSpace = THREE.SRGBColorSpace
        container.appendChild(this.renderer.domElement)
        this.renderer.domElement.setAttribute('aria-label', '料车、推链、物料与炉门联动三维画面')
        this.controls = new OrbitControls(this.camera, this.renderer.domElement)
        this.controls.enableDamping = true
        this.controls.maxPolarAngle = Math.PI * .49
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x768b9c, 2.1))
        const key = new THREE.DirectionalLight(0xffffff, 2.6)
        key.position.set(8, 12, 10)
        this.scene.add(key)
        const fill = new THREE.DirectionalLight(0xd2e6ff, 1.5)
        fill.position.set(-7, 6, -8)
        this.scene.add(fill)
        const grid = new THREE.GridHelper(24, 48, 0xaabdd0, 0xd5dfe7)
        grid.position.set(1.5, -.015, 1.2)
        this.scene.add(grid)
        this.observer = new ResizeObserver(() => this.resize())
        this.observer.observe(container)
        this.resize()
        let previous = performance.now()
        const render = now => {
            if (this.disposed || !this.active) return
            const delta = Math.max(0, Math.min(.1, (now - previous) / 1000))
            previous = now
            onTick(delta)
            this.controls.update()
            this.renderer.render(this.scene, this.camera)
            this.frame = requestAnimationFrame(render)
        }
        this.render = render
        this.frame = requestAnimationFrame(render)
    }

    resize() {
        const { width, height } = this.container.getBoundingClientRect()
        this.camera.aspect = Math.max(1, width) / Math.max(1, height)
        this.camera.updateProjectionMatrix()
        this.renderer.setSize(Math.max(1, width), Math.max(1, height))
    }

    setActive(active) {
        if (this.disposed || this.active === active) return
        this.active = active
        if (active) { this.resize(); this.frame = requestAnimationFrame(this.render) }
        else cancelAnimationFrame(this.frame)
    }

    async load({ modelId, furnaceUrl, cartUrl, furnaceMetadata }) {
        const profile = TRANSFER_MODEL_PROFILES[modelId]
        if (!profile) throw new Error('该设备型号尚未配置料车联动节点')
        this.profile = profile
        const loader = new GLTFLoader()
        const results = await Promise.allSettled([loader.loadAsync(furnaceUrl), loader.loadAsync(cartUrl)])
        if (this.disposed || results.some(result => result.status === 'rejected')) {
            for (const result of results) if (result.status === 'fulfilled') disposeObject(result.value.scene)
            if (!this.disposed) throw new Error(results.find(result => result.status === 'rejected').reason?.message || '联动模型加载失败')
            return
        }
        const [furnaceGltf, cartGltf] = results.map(result => result.value)
        restoreGltfNodeNames(furnaceGltf)
        restoreGltfNodeNames(cartGltf)
        this.furnace = furnaceGltf.scene
        this.cart = cartGltf.scene
        // This CAD group is detached from the machine and sits outside the
        // working area. Exclude that group without hiding the fitted pipework.
        for (const name of profile.hiddenNodes || []) {
            const node = this.furnace.getObjectByName(name)
            if (node) node.visible = false
        }
        this.furnace.rotation.y = profile.rotationY
        this.scene.add(this.furnace, this.cart)
        this.shuttle = this.cart.getObjectByName('cart_v6_node_cart_feed_shuttle')
        const front = this.furnace.getObjectByName(profile.doorNode)
        const mouth = this.furnace.getObjectByName(profile.mouthNode)
        if (!front || !mouth || !this.shuttle) throw new Error('所选模型缺少炉门、炉口或送料滑台节点')
        this.furnace.position.z -= new THREE.Box3().setFromObject(mouth).getCenter(new THREE.Vector3()).z
        this.furnace.updateMatrixWorld(true)
        this.shuttleBase = this.shuttle.position.clone()
        const metadata = typeof furnaceMetadata === 'string' ? JSON.parse(furnaceMetadata) : furnaceMetadata || {}
        this.doors = (metadata.partBindings || []).filter(binding => binding.source_group === 'doors' && binding.action === 'translate')
            .map(binding => {
                const target = this.furnace.getObjectByName(binding.node_name)
                return target && { target, base: target.position.clone(), axis: binding.axis || 'y',
                    min: Number(binding.output_min || 0), max: Number(binding.output_max || 1.5) }
            }).filter(Boolean)
        if (!this.doors.length) throw new Error('请先在部件动作中配置该设备的炉门动作绑定')
        const rails = this.cart.getObjectByName('cart_v6_node_cart_reference_rails')
        if (rails) rails.visible = false
        const mouthBox = new THREE.Box3().setFromObject(mouth)
        this.cart.rotation.y = Math.PI
        this.cart.updateMatrixWorld(true)
        const chassis = this.cart.getObjectByName('cart_v6_node_cart_open_chassis') || this.cart
        const chassisBox = new THREE.Box3().setFromObject(chassis)
        // The original roller centre is Z=-.085; after turning the cart, offset
        // its root so the roller bed and furnace doorway share the same centre.
        this.materialLength = profile.materialLength
        const innerDoorX = Math.min(...this.doors.map(({ target }) => new THREE.Box3().setFromObject(target).min.x))
        Object.assign(this, planFeedPlacement({ mouthMaxX: mouthBox.max.x,
            mouthCenterZ: mouthBox.getCenter(new THREE.Vector3()).z, cartLeadingX: chassisBox.min.x,
            innerDoorX, materialLength: this.materialLength }))
        this.cart.position.set(this.dockX, 0, this.dockZ + this.approachDistance)
        this.material = this.makeMaterial()
        this.scene.add(this.material)
        this.chain = new THREE.InstancedMesh(new THREE.BoxGeometry(.095, .035, .055),
            new THREE.MeshStandardMaterial({ color: '#e3aa35', metalness: .65, roughness: .35 }), 180)
        this.chain.frustumCulled = false
        this.chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.scene.add(this.chain)
        this.rollers = [1, 2, 3].map(index => this.cart.getObjectByName(`cart_v6_node_cart_feed_roller_${index}_rotate`))
            .filter(Boolean).map(target => ({ target, base: target.rotation.z }))
        this.wheels = [1, 2].map(index => this.cart.getObjectByName(`cart_v6_node_cart_wheel_axle_${index}_rotate`))
            .filter(Boolean).map(target => ({ target, base: target.rotation.x }))
        this.makeRails()
        // Clone shell materials per mesh: the imported CAD/GLB can share them
        // with doors, which must remain opaque while the chamber is exposed.
        this.shellMaterials = []
        for (const name of profile.shellNodes) this.furnace.getObjectByName(name)?.traverse(mesh => {
            if (!mesh.isMesh) return
            const original = mesh.material
            const materials = (Array.isArray(original) ? original : [original]).map(material => material.clone())
            mesh.material = Array.isArray(original) ? materials : materials[0]
            this.shellMaterials.push(...materials)
        })
        this.loaded = true
        this.setCutaway(true)
        this.apply({ cart: 0, door: 0, chain: 0, material: 0 })
        this.resetCamera()
    }

    makeMaterial() {
        const group = new THREE.Group()
        const pallet = new THREE.MeshStandardMaterial({ color: '#e49c32', metalness: .3, roughness: .5 })
        const workpiece = new THREE.MeshStandardMaterial({ color: '#78a9bc', metalness: .7, roughness: .32 })
        const base = new THREE.Mesh(new THREE.BoxGeometry(this.materialLength, .10, this.profile.materialWidth), pallet)
        base.position.y = .05
        group.add(base)
        for (let x = 0; x < 3; x++) for (let z = 0; z < 2; z++) {
            const height = this.profile.materialHeight - .10
            const billet = new THREE.Mesh(new THREE.CylinderGeometry(.11, .11, height, 20), workpiece)
            billet.position.set((x - 1) * this.materialLength * .27, .10 + height / 2, (z - .5) * this.profile.materialWidth * .48)
            group.add(billet)
        }
        return group
    }

    makeRails() {
        const material = new THREE.MeshStandardMaterial({ color: '#7d8f9d', metalness: .7, roughness: .5 })
        for (const offset of [-1.20, 1.20]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(.065, .065, 7.4), material)
            rail.position.set(this.dockX + offset, .025, 1.65)
            this.scene.add(rail)
        }
        for (let z = -1.6; z <= 5.4; z += .65) {
            const tie = new THREE.Mesh(new THREE.BoxGeometry(2.7, .035, .15), material)
            tie.position.set(this.dockX, .005, z)
            this.scene.add(tie)
        }
    }

    setCutaway(enabled) {
        for (const material of this.shellMaterials || []) {
            material.transparent = !!enabled
            material.opacity = enabled ? .19 : 1
            material.depthWrite = !enabled
            material.needsUpdate = true
        }
    }

    apply(pose) {
        if (!this.loaded) return
        const cartZ = this.dockZ + this.approachDistance * (1 - pose.cart)
        this.cart.position.z = cartZ
        for (const door of this.doors) door.target.position[door.axis] = door.base[door.axis] + THREE.MathUtils.lerp(door.min, door.max, pose.door)
        this.shuttle.position.x = this.shuttleBase.x + this.feedDistance * pose.chain
        this.material.position.set(THREE.MathUtils.lerp(this.materialStartX, this.materialEndX, pose.material), this.materialY, cartZ + .085)
        for (const { target, base } of this.rollers) target.rotation.z = base + pose.material * this.feedDistance / .054
        for (const { target, base } of this.wheels) target.rotation.x = base + pose.cart * this.approachDistance / .223
        const anchor = this.dockX + 1.05
        const head = this.dockX + .0325 - this.feedDistance * pose.chain
        const length = anchor - head
        const count = Math.min(89, Math.max(2, Math.ceil(length / .11)))
        const matrix = new THREE.Matrix4()
        let index = 0
        for (const side of [-.24, .24]) for (let i = 0; i < count; i++) {
            matrix.makeTranslation(anchor - length * i / (count - 1), this.materialY + .055, cartZ + .085 + side)
            this.chain.setMatrixAt(index++, matrix)
        }
        this.chain.count = index
        this.chain.instanceMatrix.needsUpdate = true
    }

    resetCamera() {
        this.camera.position.set(10.5, 6.9, 10.1)
        this.controls.target.set(2.1, 1.55, 1.4)
        this.controls.update()
    }

    focusTransfer() {
        if (!this.loaded) return
        const center = (this.dockX + this.materialEndX) / 2
        this.camera.position.set(center + 4.4, 4.2, 6.7)
        this.controls.target.set(center, 1.6, 0)
        this.controls.update()
    }

    dispose() {
        this.disposed = true
        cancelAnimationFrame(this.frame)
        this.observer.disconnect()
        this.controls.dispose()
        disposeObject(this.scene)
        this.renderer.dispose()
        this.renderer.forceContextLoss()
        this.renderer.domElement.remove()
    }
}
