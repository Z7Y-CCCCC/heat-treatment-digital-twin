import * as THREE from 'three'
import inspectionConfig from '../../../shared/inspectionConfig.mjs'
import { InspectionPreview } from './InspectionPreview.js'

const { normalizeInspection, validateInspection } = inspectionConfig
const clone = value => JSON.parse(JSON.stringify(value))
const offsetsKey = value => JSON.stringify((value.parts || []).map(part => [part.id, part.explode_offset]))

/** A single cancellable GPU loop, shared by mount/KeepAlive activation. */
export function createManualLayoutRenderLoop(render, { requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) } = {}) {
    let running = false, disposed = false, pending = null, generation = 0
    const tick = current => {
        if (current !== generation) return
        pending = null
        if (!running || disposed) return
        render()
        if (current === generation && running && !disposed) pending = requestFrame(() => tick(current))
    }
    const pause = () => { running = false; generation++; if (pending !== null) cancelFrame(pending); pending = null }
    return {
        start() { if (!running && !disposed) { running = true; tick(++generation) } },
        pause,
        dispose() { pause(); disposed = true },
        get running() { return running && !disposed }
    }
}

/** The same opaque name/index paths used by the existing model inspection editor. */
export function buildManualNodeIndex(root) {
    const map = new Map(), nodes = []
    root.updateMatrixWorld(true)
    const walk = (parent, parentPath = '') => parent.children.forEach((node, index) => {
        const segment = `${String(node.name || node.type || 'Object3D').replace(/\//g, '_')}#${index}`
        const path = parentPath ? `${parentPath}/${segment}` : segment
        const bounds = new THREE.Box3().setFromObject(node)
        let meshCount = 0
        node.traverse(child => { if (child.isMesh) meshCount++ })
        map.set(path, node)
        nodes.push({ path, parentPath, name: node.name, displayName: node.name || node.type,
            type: node.type, isMesh: !!node.isMesh, meshCount,
            bounds: bounds.isEmpty() ? null : { min: bounds.min.toArray(), max: bounds.max.toArray() } })
        walk(node, path)
    })
    walk(root)
    return { map, nodes }
}

/** Inverse linear transform, preserving nonuniform scale and mirrored axes. */
export function worldDeltaToInspectionOffset(worldDelta, authorMatrix, offsetSpace = 'model') {
    if (Math.abs(authorMatrix.determinant()) < 1e-12) throw new Error('模型或父节点缩放为零，无法编辑拆解位移')
    const inverse = authorMatrix.clone().invert()
    const result = worldDelta.clone().applyMatrix4(inverse).sub(new THREE.Vector3().applyMatrix4(inverse))
    // Legacy parent offsets are authored in Unity's handedness. Model-space
    // offsets are already canonical glTF coordinates and must not be mirrored.
    if (offsetSpace === 'parent') result.x = -result.x
    return result
}

function editableConfig(value) {
    const source = clone(value || {})
    const normalized = normalizeInspection(source)
    return { ...normalized, ...source, parts: normalized.parts.map((part, index) => ({
        ...part, ...(source.parts?.[index] || {}), explode_offset: [...part.explode_offset]
    })) }
}

/** Owns only editor wrappers/material clones; original mesh transforms are never written. */
export class ManualDisassemblyLayoutRuntime {
    constructor({ root, scene, inspection, camera = new THREE.PerspectiveCamera(), onChange = () => {} }) {
        this.root = root
        this.scene = scene
        this.onChange = onChange
        this.draft = editableConfig(inspection)
        this.saved = clone(this.draft)
        const { map, nodes } = buildManualNodeIndex(root)
        this.nodes = nodes
        this.validation = validateInspection({ ...this.draft, enabled: true }, nodes)
        if (!this.validation.valid) throw new Error(this.validation.errors.map(error => error.message).join('；'))
        // No renderer/controls: reuse production pivot/rotation/offset math,
        // without its click-to-advance handler or automatic camera movement.
        this.preview = new InspectionPreview({ root, scene, camera, nodeMap: map, nodes, config: { ...this.draft, enabled: true } })
        this.parts = this.preview.parts
        this.selectedId = this.parts[0]?.config.id || ''
        this.history = [clone(this.draft)]
        this.historyIndex = 0
        this.assembled = false
        this.apply()
    }

    get dirty() { return offsetsKey(this.draft) !== offsetsKey(this.saved) }
    get canUndo() { return this.historyIndex > 0 }
    get canRedo() { return this.historyIndex + 1 < this.history.length }
    get selectedPart() { return this.parts.find(part => part.config.id === this.selectedId) }
    getDraft() { return clone(this.draft) }

    apply() {
        for (const part of this.parts) {
            const draft = this.draft.parts.find(item => item.id === part.config.id)
            part.config.explode_offset = [...draft.explode_offset]
        }
        this.preview.selectedId = this.selectedId
        this.preview.stage = this.assembled ? 'solid' : 'exploded'
        this.preview.apply(this.assembled ? 0 : this.preview.timeline.duration)
        this.onChange(this)
    }

    select(id) {
        if (!this.parts.some(part => part.config.id === id)) return false
        this.selectedId = id
        this.apply()
        return true
    }

    selectedCenter() { return this.selectedPart?.bounds.getCenter(new THREE.Vector3()) || new THREE.Vector3() }
    bounds() { return this.preview.visibleBounds(true) }

    authorMatrix() {
        this.root.updateWorldMatrix(true, true)
        return this.draft.offset_space === 'parent'
            ? this.preview.wrappers.find(entry => entry.part.id === this.selectedId)?.parent.matrixWorld || this.root.matrixWorld
            : this.root.matrixWorld
    }

    beginDrag(worldPosition = this.selectedCenter()) {
        if (!this.selectedPart || this.assembled) return false
        this.drag = { start: worldPosition.clone(), offset: [...this.draft.parts.find(part => part.id === this.selectedId).explode_offset],
            matrix: this.authorMatrix().clone(), before: clone(this.draft) }
        return true
    }

    dragTo(worldPosition) {
        if (!this.drag) return
        const delta = worldDeltaToInspectionOffset(worldPosition.clone().sub(this.drag.start), this.drag.matrix, this.draft.offset_space)
        const offset = this.drag.offset.map((value, index) => value + delta.getComponent(index))
        if (!offset.every(Number.isFinite)) throw new Error('拖拽坐标无效，未写入布局')
        this.draft.parts.find(part => part.id === this.selectedId).explode_offset = offset
        this.apply()
    }

    endDrag(cancel = false) {
        if (!this.drag) return
        if (cancel) this.draft = this.drag.before
        this.drag = null
        if (!cancel) this.commit()
        this.apply()
    }

    commit() {
        if (offsetsKey(this.draft) === offsetsKey(this.history[this.historyIndex])) return
        this.history.splice(this.historyIndex + 1)
        this.history.push(clone(this.draft))
        if (this.history.length > 100) this.history.shift()
        this.historyIndex = this.history.length - 1
    }

    setOffset(id, offset) {
        if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(value => Number.isFinite(Number(value)))) return false
        const part = this.draft.parts.find(item => item.id === id)
        if (!part) return false
        part.explode_offset = offset.map(Number)
        this.commit()
        this.apply()
        return true
    }

    undo() { if (this.canUndo) { this.draft = clone(this.history[--this.historyIndex]); this.apply() } }
    redo() { if (this.canRedo) { this.draft = clone(this.history[++this.historyIndex]); this.apply() } }
    restoreSaved() { this.draft = clone(this.saved); this.commit(); this.apply() }
    markSaved(inspection = this.draft) {
        this.draft = editableConfig(inspection)
        this.saved = clone(this.draft)
        this.history = [clone(this.draft)]; this.historyIndex = 0
        this.apply()
    }
    setAssembled(value) { this.assembled = value; this.apply() }
    dispose() { if (this.disposed) return; this.disposed = true; this.preview.dispose() }
}
