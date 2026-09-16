import * as THREE from 'three'
import inspectionConfig from '../../../shared/inspectionConfig.mjs'

const { normalizeInspection, validateInspection } = inspectionConfig
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0))
const vector = (value) => new THREE.Vector3(...(Array.isArray(value) ? value : [0, 0, 0]))
const unique = (values) => [...new Set(values.filter(Boolean))]
const isBelow = (node, ancestor) => {
    for (let current = node; current; current = current.parent) if (current === ancestor) return true
    return false
}
const visibleInHierarchy = node => {
    for (let current = node; current; current = current.parent) if (current.visible === false) return false
    return true
}
const pathBelow = (path, ancestor) => path === ancestor || path.startsWith(`${ancestor}/`)
const targetsOf = (part) => ({
    paths: unique([part.node_path, ...(part.node_paths || [])]),
    names: unique([part.node_name, ...(part.node_names || [])])
})

export function inspectionTimeline(config) {
    const normalized = normalizeInspection(config)
    const parts = normalized.parts.filter(part => part.enabled !== false).map((part, index) => ({
        id: part.id,
        start: normalized.shell_duration + index * normalized.stagger + part.delay,
        duration: part.duration || normalized.animation_duration
    }))
    return { parts, duration: Math.max(normalized.shell_duration, ...parts.map(part => part.start + part.duration), 0.05) }
}

export function inspectionEase(value, easing = 'smoothstep') {
    const progress = clamp(value)
    if (easing === 'linear') return progress
    if (easing === 'cubic') return progress < 0.5 ? 4 * progress ** 3 : 1 - ((-2 * progress + 2) ** 3) / 2
    return progress * progress * (3 - 2 * progress)
}

function nodeBounds(nodes) {
    const result = new THREE.Box3()
    for (const node of nodes) {
        const bounds = node.bounds
        if (!bounds) continue
        if (bounds.min && bounds.max) result.union(new THREE.Box3(vector(bounds.min), vector(bounds.max)))
        else if (bounds.center && bounds.size) result.union(new THREE.Box3().setFromCenterAndSize(vector(bounds.center), vector(bounds.size)))
    }
    return result
}

function recordsForPart(part, nodes) {
    const { paths, names } = targetsOf(part)
    return nodes.filter(node => paths.includes(node.path) || names.includes(node.name))
}

/** Only authored groups become automatic assemblies; a material mesh is never invented into a CAD part. */
export function generateInspectionParts(nodes, { parentPath = '', existingParts = [], partBindings = [] } = {}) {
    const groups = nodes.filter(node => !node.isMesh && node.type !== 'Mesh' && node.meshCount > 0)
    let children = groups.filter(node => (node.parentPath || '') === parentPath)
    if (!parentPath) {
        const seen = new Set()
        while (children.length === 1 && !seen.has(children[0].path)) {
            seen.add(children[0].path)
            const nested = groups.filter(node => node.parentPath === children[0].path)
            if (!nested.length) break
            children = nested
        }
    }
    const allExistingTargets = existingParts.flatMap(part => recordsForPart(part, nodes))
    const ids = new Set(existingParts.map(part => part.id))
    const generated = []
    for (const node of children) {
        if (allExistingTargets.some(target => pathBelow(target.path, node.path) || pathBelow(node.path, target.path))) continue
        if (existingParts.length + generated.length >= 64) break
        let suffix = 1
        let id = `assembly_${suffix}`
        while (ids.has(id)) id = `assembly_${++suffix}`
        ids.add(id)
        const linked = partBindings.filter(binding => (
            binding.node_path && pathBelow(binding.node_path, node.path)
        ) || (binding.node_name && nodes.some(child => child.name === binding.node_name && pathBelow(child.path, node.path))))
        generated.push({
            id, name: node.displayName || node.name, group: '', enabled: true,
            node_path: node.path, node_name: '', node_paths: [], node_names: [],
            explode_offset: [0, 0, 0], explode_rotation: [0, 0, 0], delay: 0, duration: 0,
            label_offset: [0, 0.35, 0], description: '', camera: null, detail_view_id: '',
            point_ids: unique(linked.flatMap(binding => [binding.point_id, ...(binding.point_ids || [])])),
            point_keys: unique(linked.map(binding => binding.source_group && binding.source_key ? `${binding.source_group}.${binding.source_key}` : ''))
        })
    }
    return generated
}

/** Editable layout suggestion in model-local units; existing IDs, labels and PLC associations are retained. */
export function spreadInspectionParts(parts, nodes, { mode = 'radial', spacing = 1 } = {}) {
    const boxes = parts.map(part => nodeBounds(recordsForPart(part, nodes)))
    const rootBox = nodeBounds(nodes)
    const center = rootBox.isEmpty() ? new THREE.Vector3() : rootBox.getCenter(new THREE.Vector3())
    const size = rootBox.isEmpty() ? new THREE.Vector3(1, 1, 1) : rootBox.getSize(new THREE.Vector3())
    const extent = Math.max(size.x, size.y, size.z, 0.01)
    const scale = clamp(spacing, 0.1, 5)
    const columns = Math.ceil(Math.sqrt(parts.length || 1))
    const cell = Math.max(...boxes.map(box => box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length()), extent * 0.2) * 0.8 * scale
    return parts.map((part, index) => {
        const box = boxes[index]
        const partCenter = box.isEmpty() ? center.clone() : box.getCenter(new THREE.Vector3())
        const radius = box.isEmpty() ? extent * 0.05 : box.getSize(new THREE.Vector3()).length() * 0.5
        let offset
        if (mode === 'grid') {
            const destination = center.clone().add(new THREE.Vector3(
                (index % columns - (columns - 1) / 2) * cell, extent * 0.3,
                (Math.floor(index / columns) - (Math.ceil(parts.length / columns) - 1) / 2) * cell
            ))
            offset = destination.sub(partCenter)
        } else if (['x', 'y', 'z'].includes(mode)) {
            offset = new THREE.Vector3()
            offset[mode] = (index - (parts.length - 1) / 2) * cell
        } else {
            const direction = partCenter.clone().sub(center)
            if (direction.length() < extent * 0.16) {
                const angle = index * Math.PI * (3 - Math.sqrt(5))
                direction.set(Math.cos(angle), 0.15 + (index % 3) * 0.1, Math.sin(angle))
            }
            offset = direction.normalize().multiplyScalar((extent * 0.55 + radius * 0.55) * scale)
        }
        return { ...part, explode_offset: offset.toArray().map(value => Math.round(value * 1000) / 1000) }
    })
}

export function inspectionCameraPose(camera, bounds, config = {}, rootMatrix = new THREE.Matrix4()) {
    const box = bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.05, -0.05, -0.05), new THREE.Vector3(0.05, 0.05, 0.05)) : bounds
    const target = box.getCenter(new THREE.Vector3())
    const localOffset = vector(config.target_offset)
    const worldOrigin = new THREE.Vector3().applyMatrix4(rootMatrix)
    target.add(localOffset.applyMatrix4(rootMatrix).sub(worldOrigin))
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.002)
    const verticalFov = THREE.MathUtils.degToRad(camera.fov || 45)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (camera.aspect || 1))
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * clamp(config.distance_scale ?? 1.12, 0.05, 20)
    const yaw = THREE.MathUtils.degToRad(Number(config.yaw ?? 238))
    const pitch = THREE.MathUtils.degToRad(clamp(config.pitch ?? 19, -89, 89))
    const direction = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    direction.transformDirection(rootMatrix)
    return { position: target.clone().addScaledVector(direction, distance), target, radius }
}

/** Uses an existing scene/camera/render loop. dispose() restores the exact mesh materials and hierarchy. */
export class InspectionPreview {
    constructor({ root, nodeMap, nodes = [], camera, controls, renderer, scene, config, onState = () => {}, onSelect = () => {} }) {
        Object.assign(this, { root, nodeMap, nodes, camera, controls, renderer, scene, onState, onSelect })
        this.config = normalizeInspection(config)
        this.validation = validateInspection(config, nodes)
        this.timeline = inspectionTimeline(this.config)
        this.time = 0
        this.stage = 'solid'
        this.playing = false
        this.paused = false
        this.direction = 1
        this.selectedId = ''
        this.hoveredId = ''
        this.isolated = false
        this.labelsEnabled = this.config.labels.enabled
        this.xrayAmount = 0
        this.materials = []
        this.wrappers = []
        this.parts = []
        this.stateElapsed = 0
        this.lastPickTime = -Infinity
        this.highlightColors = { selected: new THREE.Color(0x12697a), hovered: new THREE.Color(0x604717), black: new THREE.Color(0) }
        this.disposed = false
        this.raycaster = new THREE.Raycaster()
        this.root.updateMatrixWorld(true)
        this.baseBounds = new THREE.Box3().setFromObject(root)
        this.previousClipping = renderer?.localClippingEnabled
        if (renderer) renderer.localClippingEnabled = true
        this.previousMinDistance = controls?.minDistance
        this.previousAutoRotate = controls?.autoRotate
        if (controls) controls.autoRotate = false
        this.prepare()
        this.attachEvents()
        this.apply(0)
        this.publish()
    }

    resolve(part) {
        const { paths, names } = targetsOf(part)
        const targets = unique([
            ...paths.map(path => this.nodeMap.get(path)),
            ...names.flatMap(name => [...this.nodeMap.values()].filter(node => node.name === name))
        ])
        return targets.filter(node => !targets.some(ancestor => ancestor !== node && isBelow(node, ancestor)))
    }

    prepare() {
        const claimed = []
        for (const part of this.config.parts.filter(part => this.config.enabled && part.enabled !== false)) {
            const targets = this.resolve(part)
            if (!targets.length || targets.some(target => claimed.some(other => isBelow(target, other) || isBelow(other, target)))) continue
            claimed.push(...targets)
            this.parts.push({ config: part, targets, bounds: new THREE.Box3() })
        }
        const shellRoots = this.config.enabled ? this.resolve(this.config.shell) : []
        this.shellMeshes = new Set()
        for (const shell of shellRoots) {
            // A shell root that contains a part is too broad to classify safely:
            // its unconfigured descendants would otherwise disappear with the shell.
            // The shared validator blocks saving this configuration; keep the
            // preview safe as well when it receives an older/bypassed document.
            if (claimed.some(target => isBelow(target, shell) || isBelow(shell, target))) continue
            shell.traverse(mesh => {
                if (!mesh.isMesh) return
                this.shellMeshes.add(mesh)
            })
        }
        const inverseRoot = this.root.matrixWorld.clone().invert()
        this.shellLocalBounds = new THREE.Box3()
        for (const mesh of this.shellMeshes) {
            mesh.geometry?.computeBoundingBox?.()
            if (mesh.geometry?.boundingBox) this.shellLocalBounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(inverseRoot.clone().multiply(mesh.matrixWorld)))
        }
        this.root.traverse(mesh => {
            if (!mesh.isMesh || !mesh.material) return
            const original = mesh.material
            const clones = (Array.isArray(original) ? original : [original]).map(material => material.clone())
            const originals = Array.isArray(original) ? original : [original]
            mesh.material = Array.isArray(original) ? clones : clones[0]
            this.materials.push({ mesh, original, originals, clones, visible: mesh.visible, appliedVisible: mesh.visible })
        })
        for (const part of this.parts) {
            const assemblyBounds = new THREE.Box3()
            for (const target of part.targets) target.traverse(mesh => {
                if (!mesh.isMesh || !mesh.geometry) return
                mesh.geometry.computeBoundingBox()
                assemblyBounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(inverseRoot.clone().multiply(mesh.matrixWorld)))
            })
            const assemblyPivot = assemblyBounds.getCenter(new THREE.Vector3())
            for (const target of part.targets) {
                const parent = target.parent
                if (!parent) continue
                const originalIndex = parent.children.indexOf(target)
                const pivot = assemblyPivot.clone()
                const wrapper = new THREE.Group()
                wrapper.name = '__inspection_offset__'
                wrapper.matrixAutoUpdate = false
                parent.remove(target)
                parent.add(wrapper)
                parent.children.splice(parent.children.indexOf(wrapper), 1)
                parent.children.splice(originalIndex, 0, wrapper)
                wrapper.add(target)
                this.wrappers.push({ wrapper, parent, target, pivot, part: part.config, originalIndex })
            }
        }
        this.applyTransforms(this.timeline.duration)
        this.explodedBounds = this.visibleBounds(true)
        this.applyTransforms(0)
        this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x29d5ec)
        this.selectionBox.name = '__inspection_selected_outline__'
        this.selectionBox.visible = false
        this.selectionBox.material.depthTest = false
        this.selectionBox.renderOrder = 20
        this.scene?.add(this.selectionBox)
        this.hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xffc46b)
        this.hoverBox.name = '__inspection_hover_outline__'
        this.hoverBox.visible = false
        this.hoverBox.material.depthTest = false
        this.hoverBox.renderOrder = 19
        this.scene?.add(this.hoverBox)
    }

    visibleBounds(excludeShell = false) {
        const box = new THREE.Box3()
        for (const { mesh, visible } of this.materials) {
            if (!visible || (excludeShell && this.shellMeshes.has(mesh))) continue
            box.expandByObject(mesh)
        }
        return box.isEmpty() ? this.baseBounds.clone() : box
    }

    applyTransforms(time) {
        const rootWorld = this.root.matrixWorld
        for (const entry of this.wrappers) {
            const timing = this.timeline.parts.find(part => part.id === entry.part.id)
            const amount = inspectionEase(timing ? (time - timing.start) / timing.duration : 0, this.config.easing)
            if (amount === 0) {
                entry.wrapper.matrix.identity()
            } else {
                entry.parent.updateWorldMatrix(true, false)
                const rootToParent = entry.parent.matrixWorld.clone().invert().multiply(rootWorld)
                const pivot = this.config.offset_space === 'model' ? entry.pivot : entry.pivot.clone().applyMatrix4(rootToParent)
                const delta = new THREE.Matrix4().makeTranslation(...vector(entry.part.explode_offset).multiplyScalar(amount).toArray())
                delta.multiply(new THREE.Matrix4().makeTranslation(...pivot.toArray()))
                delta.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...entry.part.explode_rotation.map(value => THREE.MathUtils.degToRad(value) * amount), 'XYZ')))
                delta.multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()))
                if (this.config.offset_space === 'model') entry.wrapper.matrix.copy(rootToParent).multiply(delta).multiply(rootToParent.clone().invert())
                else entry.wrapper.matrix.copy(delta)
            }
            entry.wrapper.matrixWorldNeedsUpdate = true
        }
        this.root.updateMatrixWorld(true)
        for (const part of this.parts) {
            part.bounds.makeEmpty()
            for (const target of part.targets) part.bounds.expandByObject(target)
        }
    }

    apply(time) {
        this.applyTransforms(time)
        const shellProgress = inspectionEase(this.config.shell_duration > 0 ? clamp(time / this.config.shell_duration) : Number(time > 0), this.config.easing)
        const shell = this.config.shell
        const plane = new THREE.Plane()
        const axis = shell.axis || 'y'
        const direction = shell.direction === -1 ? -1 : 1
        plane.normal.set(0, 0, 0)[axis] = direction
        const min = this.shellLocalBounds.min[axis]
        const max = this.shellLocalBounds.max[axis]
        const threshold = direction > 0 ? min + (max - min) * shellProgress : max - (max - min) * shellProgress
        plane.constant = -direction * threshold
        plane.applyMatrix4(this.root.matrixWorld)
        this.clipPlane = plane
        const selected = this.parts.find(part => part.config.id === this.selectedId)
        const hovered = this.parts.find(part => part.config.id === this.hoveredId)
        for (const entry of this.materials) {
            const { mesh, clones, originals } = entry
            // Keep independent PLC visibility changes while distinguishing our own temporary shell mask.
            if (mesh.visible !== entry.appliedVisible) entry.visible = mesh.visible
            const isShell = this.shellMeshes.has(mesh)
            const isSelected = !!selected?.targets.some(target => isBelow(mesh, target))
            const isHovered = !!hovered?.targets.some(target => isBelow(mesh, target))
            mesh.visible = entry.visible && !(isShell && shellProgress >= 0.99999) && !(this.isolated && selected && !isSelected)
            entry.appliedVisible = mesh.visible
            clones.forEach((material, index) => {
                const original = originals[index]
                let opacity = original.opacity
                if (isShell) {
                    opacity *= 1 - inspectionEase(this.xrayAmount, this.config.easing) * (1 - shell.opacity)
                    if (shell.transition === 'fade') opacity *= 1 - shellProgress
                }
                const transparent = original.transparent || opacity < original.opacity - 0.001
                const clippingPlanes = isShell && shell.transition === 'clip' && shellProgress > 0 && shellProgress < 1 ? [plane] : null
                const wireframe = original.wireframe || !!(isShell && shell.wireframe && this.xrayAmount > 0.5)
                if (material.transparent !== transparent || !!material.clippingPlanes !== !!clippingPlanes || material.wireframe !== wireframe) material.needsUpdate = true
                material.opacity = opacity
                material.transparent = transparent
                material.depthWrite = transparent ? false : original.depthWrite
                material.wireframe = wireframe
                material.clippingPlanes = clippingPlanes
                if (material.emissive) {
                    material.emissive.copy(original.emissive || this.highlightColors.black)
                    if (isSelected || isHovered) material.emissive.lerp(isSelected ? this.highlightColors.selected : this.highlightColors.hovered, 0.68)
                }
            })
        }
        if (this.selectionBox) {
            this.selectionBox.visible = !!selected && !selected.bounds.isEmpty()
            if (selected) this.selectionBox.box.copy(selected.bounds)
        }
        if (this.hoverBox) {
            this.hoverBox.visible = !!hovered && hovered !== selected && !hovered.bounds.isEmpty()
            if (hovered) this.hoverBox.box.copy(hovered.bounds)
        }
    }

    stagePose(stage = this.stage) {
        return inspectionCameraPose(this.camera, stage === 'exploded' ? this.explodedBounds : this.baseBounds, this.config[stage]?.camera, this.root.matrixWorld)
    }

    beginCamera(getPose, duration = 0.5, independent = false) {
        this.cameraMotion = { from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), getPose, duration: Math.max(duration, 0.05), elapsed: 0, independent }
    }

    setCameraPose(pose) {
        this.camera.position.copy(pose.position)
        this.controls.target.copy(pose.target)
        this.camera.near = Math.max(0.0001, pose.radius / 1000)
        this.camera.far = Math.max(this.baseBounds.getSize(new THREE.Vector3()).length() * 100, pose.radius * 100, 100)
        this.controls.minDistance = Math.max(0.0005, pose.radius * 0.05)
        this.camera.lookAt(pose.target)
        this.camera.updateProjectionMatrix()
    }

    setStage(stage) {
        if (!['solid', 'xray', 'exploded'].includes(stage)) return
        if (!this.config.enabled) stage = 'solid'
        this.stage = stage
        this.selectedId = ''
        this.hoveredId = ''
        this.isolated = false
        this.direction = stage === 'exploded' ? 1 : -1
        this.playing = stage === 'exploded' ? this.time < this.timeline.duration : this.time > 0
        this.paused = false
        const duration = this.playing ? (this.direction > 0 ? this.timeline.duration - this.time : this.time) : this.config[stage].transition_seconds
        this.beginCamera(() => this.stagePose(stage), duration)
        this.apply(this.time)
        this.publish()
    }

    setProgress(progress) {
        if (!this.config.enabled) { this.time = 0; this.stage = 'solid'; this.playing = false; this.publish(); return }
        const reversing = this.direction < 0 && this.time > 0
        this.time = clamp(progress) * this.timeline.duration
        this.stage = reversing ? 'solid' : 'exploded'
        this.direction = reversing ? -1 : 1
        this.playing = false
        this.paused = true
        this.cameraMotion = null
        this.xrayAmount = 0
        this.apply(this.time)
        const solid = this.stagePose('solid')
        const exploded = this.stagePose('exploded')
        const amount = inspectionEase(progress, this.config.easing)
        this.setCameraPose({ position: solid.position.lerp(exploded.position, amount), target: solid.target.lerp(exploded.target, amount), radius: THREE.MathUtils.lerp(solid.radius, exploded.radius, amount) })
        this.publish()
    }

    capturePlaybackState() {
        return {
            progress: this.time / this.timeline.duration, stage: this.stage, direction: this.direction,
            playing: this.playing, paused: this.paused, selectedId: this.selectedId, isolated: this.isolated,
            xrayAmount: this.xrayAmount, position: this.camera.position.clone(), target: this.controls.target.clone(),
            cameraConfig: JSON.stringify(this.config[this.stage]?.camera),
            cameraRemaining: this.cameraMotion ? Math.max(0, this.cameraMotion.duration - this.cameraMotion.elapsed) : 0
        }
    }

    restorePlaybackState(state) {
        if (!state || !this.config.enabled) return
        this.time = clamp(state.progress) * this.timeline.duration
        this.stage = state.stage
        this.direction = state.direction
        this.playing = state.playing
        this.paused = state.paused
        this.xrayAmount = state.xrayAmount
        this.selectedId = this.parts.some(part => part.config.id === state.selectedId) ? state.selectedId : ''
        this.isolated = !!this.selectedId && state.isolated
        this.apply(this.time)
        this.camera.position.copy(state.position)
        this.controls.target.copy(state.target)
        this.camera.lookAt(state.target)
        const cameraChanged = JSON.stringify(this.config[this.stage]?.camera) !== state.cameraConfig
        if (cameraChanged) this.beginCamera(() => this.stagePose(), 0.35, true)
        else if (state.cameraRemaining > 0 && !this.selectedId) this.beginCamera(() => this.stagePose(), state.cameraRemaining)
        this.publish()
    }

    select(id, focus = true) {
        const selected = this.parts.find(part => part.config.id === id)
        this.selectedId = selected?.config.id || ''
        if (selected && focus) {
            const stageCamera = this.config[this.stage].camera
            const cameraConfig = selected.config.camera || { yaw: stageCamera.yaw, pitch: stageCamera.pitch, distance_scale: 1.12, target_offset: [0, 0, 0] }
            this.beginCamera(() => inspectionCameraPose(this.camera, selected.bounds, cameraConfig, this.root.matrixWorld), 0.65, true)
        }
        this.apply(this.time)
        this.onSelect(this.selectedId)
        this.publish()
    }

    command(command = {}) {
        if (command.command === 'stage') this.setStage(command.stage)
        else if (command.command === 'progress') this.setProgress(command.progress)
        else if (command.command === 'select') this.select(command.partId, command.focus !== false)
        else if (command.command === 'clear') { this.select(''); this.beginCamera(() => this.stagePose(), 0.6, true) }
        else if (command.command === 'pause') { this.paused = true; this.publish() }
        else if (command.command === 'resume') {
            this.paused = false
            this.playing = this.direction > 0 ? this.time < this.timeline.duration : this.time > 0
            if (!this.cameraMotion && !this.selectedId && this.playing) this.beginCamera(() => this.stagePose(), this.direction > 0 ? this.timeline.duration - this.time : this.time)
            this.publish()
        } else if (command.command === 'labels') { this.labelsEnabled = command.enabled !== false; this.publish() }
        else if (command.command === 'isolate') { this.isolated = command.enabled !== false; this.apply(this.time); this.publish() }
    }

    update(delta) {
        if (this.disposed) return
        const seconds = clamp(delta, 0, 0.2)
        if (this.playing && !this.paused) {
            const speed = Math.max(0.25, Math.min(3, Number(this.config.playback_speed) || 1))
            this.time = clamp(this.time + seconds * speed * this.direction, 0, this.timeline.duration)
            if (this.time === 0 || this.time === this.timeline.duration) this.playing = false
        }
        if (!this.paused) {
            const xrayTarget = this.stage === 'xray' && this.time === 0 ? 1 : 0
            const step = seconds / Math.max(this.config[this.stage === 'xray' ? 'xray' : 'solid'].transition_seconds, 0.05)
            this.xrayAmount += Math.sign(xrayTarget - this.xrayAmount) * Math.min(Math.abs(xrayTarget - this.xrayAmount), step)
        }
        this.apply(this.time)
        if (this.cameraMotion && (!this.paused || this.cameraMotion.independent)) {
            const motion = this.cameraMotion
            motion.elapsed += seconds
            const target = motion.getPose()
            const amount = inspectionEase(motion.elapsed / motion.duration, this.config.easing)
            this.setCameraPose({ position: motion.from.clone().lerp(target.position, amount), target: motion.fromTarget.clone().lerp(target.target, amount), radius: target.radius })
            if (amount === 1) this.cameraMotion = null
        }
        this.stateElapsed += seconds
        if (this.stateElapsed >= 0.1) { this.stateElapsed = 0; this.publish() }
    }

    project(point) {
        const projected = point.clone().project(this.camera)
        return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2, visible: projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1.18 && Math.abs(projected.y) < 1.18 }
    }

    publish() {
        this.camera.updateMatrixWorld(true)
        const modelOrigin = new THREE.Vector3().applyMatrix4(this.root.matrixWorld)
        const parts = this.parts.map(part => {
            const anchor = part.bounds.getCenter(new THREE.Vector3())
            let offset = vector(part.config.label_offset)
            if (this.config.offset_space === 'model') offset.applyMatrix4(this.root.matrixWorld).sub(modelOrigin)
            else {
                const parentMatrix = this.wrappers.find(entry => entry.part.id === part.config.id)?.parent.matrixWorld || this.root.matrixWorld
                offset.applyMatrix4(parentMatrix).sub(new THREE.Vector3().applyMatrix4(parentMatrix))
            }
            const timing = this.timeline.parts.find(item => item.id === part.config.id)
            const shown = this.config.enabled && this.labelsEnabled && timing && inspectionEase((this.time - timing.start) / timing.duration, this.config.easing) > 0.02
                && this.materials.some(entry => visibleInHierarchy(entry.mesh) && part.targets.some(target => isBelow(entry.mesh, target)))
            const projectedAnchor = this.project(anchor), projectedLabel = this.project(anchor.clone().add(offset))
            projectedAnchor.visible = !!shown && projectedAnchor.visible
            projectedLabel.visible = !!shown && projectedLabel.visible
            return {
                ...part.config,
                anchor: projectedAnchor, label: projectedLabel,
                selected: part.config.id === this.selectedId, hovered: part.config.id === this.hoveredId
            }
        })
        this.onState({
            stage: this.stage, progress: this.time / this.timeline.duration, duration: this.timeline.duration,
            animating: this.playing && !this.paused, paused: this.paused, isolated: this.isolated,
            labelsEnabled: this.labelsEnabled, leaderLines: this.config.labels.leader_lines,
            phase: !this.playing ? 'idle' : this.time < this.config.shell_duration ? 'shell' : 'parts',
            selectedId: this.selectedId, hoveredId: this.hoveredId, parts,
            issues: this.validation.errors
        })
    }

    hit(event) {
        const rect = this.renderer?.domElement?.getBoundingClientRect()
        if (!rect?.width || !rect?.height) return ''
        this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera)
        const hits = this.raycaster.intersectObjects(this.materials.map(entry => entry.mesh), false)
        for (const hit of hits) {
            if (!hit.object.isMesh || !hit.object.visible) continue
            let hidden = false
            for (let node = hit.object.parent; node && node !== this.root; node = node.parent) if (!node.visible) hidden = true
            if (hidden) continue
            const materials = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material]
            if (materials.every(material => material.opacity < 0.15)) continue
            if (materials.some(material => material.clippingPlanes?.some(plane => plane.distanceToPoint(hit.point) < 0))) continue
            return this.parts.find(part => part.targets.some(target => isBelow(hit.object, target)))?.config.id || ''
        }
        return ''
    }

    attachEvents() {
        const element = this.renderer?.domElement
        if (!element?.addEventListener) return
        this.listeners = {
            pointermove: event => {
                const now = performance.now()
                if (now - this.lastPickTime < 50) return
                this.lastPickTime = now
                const id = this.hit(event)
                if (id === this.hoveredId) return
                this.hoveredId = id
                element.style.cursor = id ? 'pointer' : ''
                this.apply(this.time)
                this.publish()
            },
            pointerleave: () => { this.hoveredId = ''; element.style.cursor = ''; this.apply(this.time); this.publish() },
            pointerdown: event => { this.pointerStart = { x: event.clientX, y: event.clientY } },
            pointerup: event => {
                if (!this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) return
                const id = this.hit(event)
                if (id) this.select(id)
            }
        }
        for (const [name, handler] of Object.entries(this.listeners)) element.addEventListener(name, handler)
        this.onOrbitStart = () => { this.cameraMotion = null }
        this.controls?.addEventListener?.('start', this.onOrbitStart)
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        const element = this.renderer?.domElement
        for (const [name, handler] of Object.entries(this.listeners || {})) element?.removeEventListener?.(name, handler)
        if (element?.style) element.style.cursor = ''
        this.controls?.removeEventListener?.('start', this.onOrbitStart)
        for (const entry of this.wrappers) {
            entry.wrapper.remove(entry.target)
            const index = entry.parent.children.indexOf(entry.wrapper)
            entry.parent.remove(entry.wrapper)
            entry.parent.add(entry.target)
            entry.parent.children.splice(entry.parent.children.indexOf(entry.target), 1)
            entry.parent.children.splice(index >= 0 ? index : entry.originalIndex, 0, entry.target)
        }
        for (const { mesh, original, clones, visible } of this.materials) {
            mesh.material = original
            mesh.visible = visible
            clones.forEach(material => material.dispose())
        }
        for (const helper of [this.selectionBox, this.hoverBox]) {
            this.scene?.remove(helper)
            helper?.geometry.dispose()
            helper?.material.dispose()
        }
        if (this.renderer) this.renderer.localClippingEnabled = this.previousClipping
        if (this.controls) {
            this.controls.minDistance = this.previousMinDistance
            this.controls.autoRotate = this.previousAutoRotate
        }
        this.root.updateMatrixWorld(true)
    }
}
