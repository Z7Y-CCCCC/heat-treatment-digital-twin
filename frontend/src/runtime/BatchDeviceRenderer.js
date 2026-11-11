import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneObject3D } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf, resolveBackendAssetUrl } from '../three/ModelFactory.js';
import { resolveDeviceQuality } from './DeviceRenderer.js';
import { ensureConnectionBadge3D, setConnectionBadge3D } from './ConnectionBadge3D.js';
import { layoutEditorMaterial } from './layoutEditorAppearance.js';
import { buildDeviceLabelMarkup, updateDeviceLabelElements, applyDeviceLabelStyle } from './uiConfig.js';
import {
    enhanceModelMaterial,
    resolveModelOptimization
} from './modelOptimization.js';

const STATUS_COLORS = {
    bad: new THREE.Color(0xd96060),
    stale: new THREE.Color(0xf0b35a),
    alarm: new THREE.Color(0xff3333),
    running: new THREE.Color(0x00ff88),
    idle: new THREE.Color(0x666666)
};
const BODY_COLORS = {
    bad: new THREE.Color(0xa8b0b0),
    stale: new THREE.Color(0xd8b453)
};

const BUILTIN_BATCH_MODELS = {
    transfer_cart: {
        id: 'transfer_cart',
        name: '轨道料车 / 取料小车（程序化低模）',
        file_path: null,
        default_scale: 1,
        default_label_y: 1.62,
        default_status_light_y: 1.25,
        metadata: JSON.stringify({ source: 'procedural', batchable: true })
    }
};

const tempMatrix = new THREE.Matrix4();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const identityQuaternion = new THREE.Quaternion();
const reflectionX = new THREE.Matrix4().makeScale(-1, 1, 1);

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function numberOrDefault(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function shouldMirrorX(instanceConfig) {
    return instanceConfig?.mirrorX === true
        || instanceConfig?.mirror_x === true
        || instanceConfig?.mirrorAxis === 'x'
        || instanceConfig?.mirror_axis === 'x';
}

function modelMetadata(modelInfo) {
    return parseJson(modelInfo?.metadata, {});
}

function objectPathSegment(object, index) {
    const rawName = object.name || object.type || 'Object3D';
    return `${String(rawName).replace(/\//g, '_')}#${index}`;
}

function buildObjectPathMap(root) {
    const map = new Map();
    const walk = (object, parentPath) => {
        object.children.forEach((child, index) => {
            const path = parentPath ? `${parentPath}/${objectPathSegment(child, index)}` : objectPathSegment(child, index);
            map.set(path, child);
            walk(child, path);
        });
    };
    walk(root, '');
    return map;
}

function bindingTarget(root, pathMap, binding) {
    return pathMap.get(binding.node_path)
        || root.getObjectByName(binding.node_name || binding.nodeName || '');
}

function collectBoundObjects(root, metadata) {
    const pathMap = buildObjectPathMap(root);
    const objects = new Set();
    let resolvedCount = 0;
    (Array.isArray(metadata.partBindings) ? metadata.partBindings : []).forEach((binding) => {
        const target = bindingTarget(root, pathMap, binding);
        if (!target) return;
        resolvedCount += 1;
        target.traverse(object => objects.add(object));
    });
    return { objects, resolvedCount };
}

function readBindingValue(data, binding) {
    const group = binding.source_group || binding.category;
    const key = binding.source_key || binding.value_role || binding.key;
    if (!key) return undefined;
    if (group && data?.[group] && Object.prototype.hasOwnProperty.call(data[group], key)) {
        return data[group][key];
    }

    const groups = ['analog', 'motors', 'doors', 'gas', 'mechanisms', 'status'];
    for (const groupName of groups) {
        if (Object.prototype.hasOwnProperty.call(data?.[groupName] || {}, key)) {
            return data[groupName][key];
        }
    }
    return undefined;
}

function toNumber(value, fallback = 0) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function toBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        return ['1', 'true', 'on', 'open', 'running', 'yes'].includes(value.toLowerCase());
    }
    return !!value;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function mapRange(value, inMin, inMax, outMin, outMax) {
    const span = inMax - inMin;
    const t = Math.abs(span) < 1e-6 ? 0 : clamp01((value - inMin) / span);
    return outMin + (outMax - outMin) * t;
}

function normalizeAxis(axis) {
    return ['x', 'y', 'z'].includes(axis) ? axis : 'y';
}

function applyColorToTarget(target, colorValue) {
    const color = new THREE.Color(colorValue);
    target.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
            if (material.color) material.color.copy(color);
            if (material.emissive) material.emissive.copy(color);
            material.needsUpdate = true;
        });
    });
}

function createAnimatedRoot(sourceRoot, metadata, optimization, mirrorSafe = false) {
    const root = cloneObject3D(sourceRoot);
    const pathMap = buildObjectPathMap(root);
    const keep = new Set([root]);
    const bindings = Array.isArray(metadata.partBindings) ? metadata.partBindings : [];

    bindings.forEach((binding) => {
        const target = bindingTarget(root, pathMap, binding);
        if (!target) return;
        target.traverse(object => keep.add(object));
        let parent = target.parent;
        while (parent) {
            keep.add(parent);
            if (parent === root) break;
            parent = parent.parent;
        }
    });

    root.traverse((object) => {
        [...object.children].forEach((child) => {
            if (!keep.has(child)) object.remove(child);
        });
    });

    const materials = new Set();
    const materialClones = new Map();
    root.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        child.castShadow = false;
        child.receiveShadow = false;
        const cloneMaterial = (material) => {
            if (!materialClones.has(material)) {
                const cloned = material.clone();
                if (mirrorSafe) cloned.side = THREE.DoubleSide;
                enhanceModelMaterial(cloned, optimization);
                materialClones.set(material, cloned);
                materials.add(cloned);
            }
            return materialClones.get(material);
        };
        child.material = Array.isArray(child.material)
            ? child.material.map(cloneMaterial)
            : cloneMaterial(child.material);
    });

    return { root, pathMap, materials };
}

function createBatchMaterial(sourceMaterial, optimization) {
    const material = sourceMaterial?.clone?.() || new THREE.MeshStandardMaterial({ color: 0xffffff });
    material.name = sourceMaterial?.name || sourceMaterial?.uuid || 'batch_material';
    material.vertexColors = true;
    material.userData = {
        ...(material.userData || {}),
        baseColor: sourceMaterial?.color?.clone?.() || new THREE.Color(0xd8ddd8)
    };
    if (material.color) material.color.set(0xffffff);
    enhanceModelMaterial(material, optimization);
    return material;
}

function createContactShadow(rootBox, count, name) {
    const size = rootBox.getSize(new THREE.Vector3());
    const center = rootBox.getCenter(new THREE.Vector3());
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(64, 64, 5, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
    gradient.addColorStop(0.52, 'rgba(0, 0, 0, 0.28)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    const geometry = new THREE.PlaneGeometry(
        Math.max(0.5, size.x * 0.9),
        Math.max(0.5, size.z * 0.82)
    );
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(center.x, rootBox.min.y + 0.012, center.z);
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        color: 0x000000,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return { mesh, texture };
}

function createCompactMaterial(name, color) {
    const material = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: false,
        depthWrite: true
    });
    material.name = name;
    material.userData.baseColor = color.clone ? color.clone() : new THREE.Color(color);
    return material;
}

function createTranslatedBox(size, position) {
    const geometry = new THREE.BoxGeometry(...size);
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(...position));
    return geometry;
}

function createCompactTransferCartParts() {
    const materials = {
        rail: createCompactMaterial('cart_rail', 0x2b3033),
        sleeper: createCompactMaterial('cart_sleeper', 0x4b5357),
        chassis: createCompactMaterial('cart_chassis', 0x343b40),
        deck: createCompactMaterial('cart_deck', 0xb8c0c4),
        accent: createCompactMaterial('cart_accent', 0xd9a441),
        wheel: createCompactMaterial('cart_wheel', 0x171a1c),
        load: createCompactMaterial('cart_load', 0x748087)
    };
    const grouped = new Map();
    const addBox = (key, size, position) => {
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(createTranslatedBox(size, position));
    };

    addBox('rail', [4.8, 0.08, 0.08], [0, 0.04, -0.86]);
    addBox('rail', [4.8, 0.08, 0.08], [0, 0.04, 0.86]);
    [-1.8, -0.9, 0, 0.9, 1.8].forEach((x) => {
        addBox('sleeper', [0.16, 0.05, 2.05], [x, 0.01, 0]);
    });
    addBox('chassis', [2.9, 0.28, 1.42], [0, 0.42, 0]);
    addBox('deck', [2.55, 0.16, 1.18], [0, 0.66, 0]);
    addBox('accent', [0.16, 0.74, 1.24], [1.35, 0.94, 0]);
    addBox('accent', [0.16, 0.48, 1.24], [-1.35, 0.82, 0]);
    addBox('load', [1.34, 0.34, 0.82], [-0.18, 0.93, 0]);
    [-0.95, 0.95].forEach((x) => {
        [-0.72, 0.72].forEach((z) => {
            addBox('wheel', [0.18, 0.4, 0.4], [x, 0.26, z]);
        });
    });

    const parts = [];
    const rootBox = new THREE.Box3();
    grouped.forEach((geometries, key) => {
        const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        rootBox.union(geometry.boundingBox);
        parts.push({ key, geometry, material: materials[key] });
    });

    return { parts, rootBox };
}

export function getBatchableModelInfo(deviceCfg, models = []) {
    const modelInfo = models.find(item => item.id === deviceCfg.model_type);
    if (BUILTIN_BATCH_MODELS[deviceCfg.model_type] && !modelInfo?.file_path) {
        return BUILTIN_BATCH_MODELS[deviceCfg.model_type];
    }

    if (!modelInfo || modelInfo.id === 'builtin_furnace' || !modelInfo.file_path) return null;

    const optimization = resolveModelOptimization(modelInfo);
    if (!optimization.enabled) return null;
    return modelInfo;
}

function geometrySignature(geometry) {
    const attributes = Object.entries(geometry.attributes || {})
        .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}`)
        .sort()
        .join('|');
    return `${geometry.index ? 'indexed' : 'plain'}:${attributes}`;
}

function collectMergedParts(root, excludedObjects = new Set(), optimization) {
    root.updateMatrixWorld(true);
    const grouped = new Map();
    const rootBox = new THREE.Box3().setFromObject(root);
    let sourceMeshCount = 0;

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry || !child.material) return;
        if (excludedObjects.has(child)) return;
        if (child.isSkinnedMesh || child.morphTargetInfluences) {
            throw new Error(`模型包含骨骼或 Morph 网格，自动合批已安全回退：${child.name || child.uuid}`);
        }
        if (Array.isArray(child.material) || child.geometry.groups?.length > 1) {
            throw new Error(`模型包含单网格多材质，自动合批已安全回退：${child.name || child.uuid}`);
        }
        sourceMeshCount += 1;
        const material = Array.isArray(child.material) ? child.material[0] : child.material;
        const signature = geometrySignature(child.geometry);
        const key = optimization.mergeStatic
            ? `${material.uuid}:${signature}`
            : `${child.uuid}:${material.uuid}:${signature}`;
        if (!grouped.has(key)) {
            grouped.set(key, { material: createBatchMaterial(material, optimization), geometries: [] });
        }

        const geometry = child.geometry.clone();
        geometry.applyMatrix4(child.matrixWorld);
        grouped.get(key).geometries.push(geometry);
    });

    const parts = [];
    grouped.forEach(({ material, geometries }, key) => {
        const mergedGeometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
        if (mergedGeometry) {
            mergedGeometry.computeBoundingBox();
            mergedGeometry.computeBoundingSphere();
            parts.push({ key, geometry: mergedGeometry, material });
            return;
        }
        geometries.forEach((geometry, index) => {
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            const fallbackMaterial = index === 0 ? material : material.clone();
            parts.push({ key: `${key}_${index}`, geometry, material: fallbackMaterial });
        });
    });

    return {
        parts,
        rootBox,
        diagnostics: {
            sourceMeshCount,
            staticPartCount: parts.length,
            mergedMeshCount: Math.max(0, sourceMeshCount - parts.length)
        }
    };
}

function getDefinitionTransform(definition, modelInfo) {
    const { deviceCfg, devIdx, wsIdx, gLineIdx } = definition;
    const instanceConfig = parseJson(deviceCfg.instance_config, {});
    const defaultScale = numberOrDefault(modelInfo.default_scale, 1);
    const configuredScale = numberOrDefault(deviceCfg.scale, 1);
    const instanceScale = numberOrDefault(instanceConfig.scaleMultiplier, 1);
    return {
        position: new THREE.Vector3(
            numberOrDefault(deviceCfg.pos_x, (devIdx - 2) * 14),
            numberOrDefault(deviceCfg.pos_y, 0),
            numberOrDefault(deviceCfg.pos_z, -gLineIdx * 16 - wsIdx * 20)
        ),
        rotationY: numberOrDefault(deviceCfg.rotation_y, 0),
        scale: defaultScale * configuredScale * instanceScale,
        mirrorX: shouldMirrorX(instanceConfig),
        instanceConfig
    };
}

class BatchedDeviceProxy extends THREE.Group {
    constructor(definition, index, batchRenderer, modelInfo, rootBox, options = {}) {
        super();
        const { deviceCfg } = definition;
        const transform = getDefinitionTransform(definition, modelInfo);

        this.deviceConfig = deviceCfg;
        this.modelInfo = modelInfo;
        this.metadata = modelMetadata(modelInfo);
        this.optimization = resolveModelOptimization(modelInfo);
        this.batchRenderer = batchRenderer;
        this.instanceIndex = index;
        this.furnaceId = deviceCfg.id;
        this.furnaceName = deviceCfg.name;
        this.userData.isDevice = true;
        this.userData.id = deviceCfg.id;
        this.userData.renderedByBatch = true;
        this.userData.defaultScale = numberOrDefault(modelInfo.default_scale, 1);
        this.userData.instanceConfig = transform.instanceConfig;
        this.userData.mirrorX = transform.mirrorX;

        this.position.copy(transform.position);
        this.rotation.y = transform.rotationY;
        this.scale.set(transform.mirrorX ? -transform.scale : transform.scale, transform.scale, transform.scale);
        this.localBox = rootBox.clone();
        this.worldBox = new THREE.Box3();
        this.raycastPoint = new THREE.Vector3();
        this.xRayEnabled = false;
        this.isTransferCart = modelInfo.id === 'transfer_cart';
        this.labelConfig = {
            ...(options.labelConfig || {}),
            ...(transform.instanceConfig.labelConfig || {})
        };
        this.labelElements = new Map();
        this.lastLabelValues = new Map();
        this.lastRealtimeData = null;
        this.partBindings = Array.isArray(this.metadata.partBindings) ? this.metadata.partBindings : [];
        this.bindingStates = [];
        this.animatedMaterials = new Set();

        this.installVisibleTracker();
        this.createLabel();
        this.createConnectionBadge(rootBox);
    }

    installVisibleTracker() {
        const initialVisible = this.visible;
        this._batchVisible = initialVisible;
        Object.defineProperty(this, 'visible', {
            configurable: true,
            enumerable: true,
            get: () => this._batchVisible,
            set: (visible) => {
                const nextVisible = !!visible;
                if (this._batchVisible === nextVisible) return;
                this._batchVisible = nextVisible;
                this.batchRenderer.markInstanceDirty(this.instanceIndex);
                this.batchRenderer.markXRayDirty();
            }
        });
    }

    createLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';
        applyDeviceLabelStyle(div, this.labelConfig);
        div.innerHTML = buildDeviceLabelMarkup(this.furnaceName, this.labelConfig, { isTransferCart: this.isTransferCart, deviceId: this.furnaceId });
        div.querySelectorAll('[data-label-row]').forEach((valueEl) => {
            const key = valueEl.getAttribute('data-label-row');
            const unitEl = div.querySelector(`[data-label-unit="${key}"]`) || null;
            this.labelElements.set(key, { valueEl, unitEl });
        });

        this.labelDiv = div;
        this.labelObj = new CSS2DObject(div);
        this.labelObj.visible = false;
        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(
            0,
            numberOrDefault(this.userData.instanceConfig.labelY, numberOrDefault(this.modelInfo.default_label_y, 3.3)),
            0
        );
        this.add(this.labelAnchor);
        this.labelAnchor.add(this.labelObj);
    }

    createConnectionBadge(rootBox) {
        this.connectionBadge3D = ensureConnectionBadge3D(this, { box: rootBox });
    }

    attachAnimatedRoot(sourceRoot) {
        if (!this.partBindings.length) return;
        const animated = createAnimatedRoot(
            sourceRoot,
            this.metadata,
            this.optimization,
            this.userData.mirrorX
        );
        this.animatedRoot = animated.root;
        this.animatedPathMap = animated.pathMap;
        this.animatedMaterials = animated.materials;
        this.add(this.animatedRoot);
        this.preparePartBindings();
    }

    preparePartBindings() {
        this.bindingStates = this.partBindings.map((binding) => {
            const target = bindingTarget(this.animatedRoot, this.animatedPathMap, binding);
            if (!target) return null;
            return {
                binding,
                target,
                axis: normalizeAxis(binding.axis),
                basePosition: target.position.clone(),
                baseRotation: target.rotation.clone(),
                speed: 0
            };
        }).filter(Boolean);
    }

    setConnectionBadge(quality) {
        this.userData.quality = quality;
        setConnectionBadge3D(this, quality);
    }

    setLabelVisible(visible) {
        const nextVisible = !!visible && this.labelConfig?.enabled !== false;
        if (this.labelObj) this.labelObj.visible = nextVisible;
        if (this.labelDiv) this.labelDiv.style.opacity = nextVisible ? '1' : '0';
        if (nextVisible) this.renderLabelText();
    }

    renderLabelText() {
        updateDeviceLabelElements(
            this.labelElements,
            this.lastRealtimeData || {},
            this.labelConfig,
            { isTransferCart: this.isTransferCart },
            this.lastLabelValues
        );
    }

    setXRayMode(enable) {
        const nextEnabled = !!enable;
        if (this.xRayEnabled === nextEnabled) return;
        this.xRayEnabled = nextEnabled;
        this.animatedMaterials.forEach((material) => {
            material.transparent = nextEnabled;
            material.opacity = nextEnabled ? 0.25 : 1;
            material.depthWrite = !nextEnabled;
            material.needsUpdate = true;
        });
        this.batchRenderer.markXRayDirty();
    }

    updateData(data) {
        this.lastRealtimeData = data;
        if (this.labelObj?.visible) this.renderLabelText();
        this.setConnectionBadge(resolveDeviceQuality(data));
        this.batchRenderer.updateInstanceState(this.instanceIndex, data);
        this.applyPartBindings(data);
    }

    applyPartBindings(data) {
        this.bindingStates.forEach((state) => {
            const { binding, target, axis } = state;
            const action = binding.action || 'rotate_speed';
            const rawValue = readBindingValue(data, binding);
            if (rawValue === undefined || rawValue === null) return;

            if (action === 'rotate_speed') {
                const rpm = toNumber(rawValue, 0);
                const factor = Number.isFinite(Number(binding.speed_factor))
                    ? Number(binding.speed_factor)
                    : (Math.PI * 2 / 60);
                state.speed = rpm * factor;
                return;
            }

            if (action === 'rotate_angle') {
                const angleDeg = mapRange(
                    toNumber(rawValue, 0),
                    toNumber(binding.input_min, 0),
                    toNumber(binding.input_max, 100),
                    toNumber(binding.output_min, 0),
                    toNumber(binding.output_max, 90)
                );
                target.rotation[axis] = state.baseRotation[axis] + THREE.MathUtils.degToRad(angleDeg);
                return;
            }

            if (action === 'translate') {
                const offset = mapRange(
                    toNumber(rawValue, 0),
                    toNumber(binding.input_min, 0),
                    toNumber(binding.input_max, 100),
                    toNumber(binding.output_min, 0),
                    toNumber(binding.output_max, 1)
                );
                target.position[axis] = state.basePosition[axis] + offset;
                return;
            }

            if (action === 'visibility') {
                const visible = toBool(rawValue);
                target.visible = binding.invert ? !visible : visible;
                return;
            }

            if (action === 'color') {
                applyColorToTarget(
                    target,
                    toBool(rawValue) ? (binding.on_color || '#00ff88') : (binding.off_color || '#666666')
                );
            }
        });
    }

    raycast(raycaster, intersects) {
        if (!this.visible) return;
        this.updateMatrixWorld(true);
        this.worldBox.copy(this.localBox).applyMatrix4(this.matrixWorld);
        const hitPoint = raycaster.ray.intersectBox(this.worldBox, this.raycastPoint);
        if (!hitPoint) return;

        const distance = raycaster.ray.origin.distanceTo(hitPoint);
        if (distance < raycaster.near || distance > raycaster.far) return;
        intersects.push({
            distance,
            point: hitPoint.clone(),
            object: this
        });
    }

    update(delta) {
        this.bindingStates.forEach((state) => {
            if (state.binding.action !== 'rotate_speed' || !state.speed) return;
            state.target.rotation[state.axis] += delta * state.speed;
        });
    }

    dispose() {
        this.animatedMaterials.forEach(material => material.dispose());
        this.animatedMaterials.clear();
    }
}

class DeviceBatchRenderer extends THREE.Group {
    constructor(modelInfo, parts, rootBox, definitions, options = {}) {
        super();
        this.modelInfo = modelInfo;
        this.rootBox = rootBox;
        this.definitions = definitions;
        this.proxies = [];
        this.instancedMeshes = [];
        this.statusColorHexes = new Array(definitions.length).fill(null);
        this.bodyQuality = new Array(definitions.length).fill('');
        this.statusLightOffsets = definitions.map(definition => {
            const cfg = parseJson(definition.deviceCfg.instance_config, {});
            return numberOrDefault(cfg.statusLightY, numberOrDefault(modelInfo.default_status_light_y, 2.8));
        });
        this.dirtyIndexes = new Set();
        this.transformSnapshots = definitions.map(() => ({
            visible: null,
            px: NaN,
            py: NaN,
            pz: NaN,
            rx: NaN,
            ry: NaN,
            rz: NaN,
            sx: NaN,
            sy: NaN,
            sz: NaN
        }));
        this.lastXRayMode = null;
        this.xRayDirty = true;
        this.options = options;
        const metadata = modelMetadata(modelInfo);
        this.optimization = resolveModelOptimization(modelInfo);
        this.userData.optimization = {
            modelId: modelInfo.id,
            instanceCount: definitions.length,
            ...(options.diagnostics || {}),
            mode: this.optimization.mode,
            contactShadow: this.optimization.contactShadow
        };
        this.hasMirroredInstances = definitions.some(definition => shouldMirrorX(parseJson(definition.deviceCfg.instance_config, {})));
        this.showStatusLight = options.showStatusLight === true || metadata.runtime?.showStatusLight === true;
        this.supportsXRay = options.supportsXRay === true || metadata.runtime?.allowXRay === true;

        parts.forEach(({ geometry, material: sourceMaterial, key }) => {
            const material = options.renderProfile === 'layout-editor'
                ? layoutEditorMaterial(sourceMaterial, { instanced: true }) : sourceMaterial;
            if (material !== sourceMaterial) sourceMaterial.dispose();
            if (this.hasMirroredInstances) {
                material.side = THREE.DoubleSide;
                material.needsUpdate = true;
            }
            const mesh = new THREE.InstancedMesh(geometry, material, definitions.length);
            // WebGLRenderer flips triangle facing from the OBJECT matrix, not
            // each instance matrix. A negative instance determinant + DoubleSide
            // alone inverts fragment normals. Keep instances positive and put
            // the common reflection on the draw object: R * (R * W) = W.
            if (this.hasMirroredInstances) mesh.scale.x = -1;
            mesh.name = `batch_${modelInfo.id}_${key}`;
            mesh.frustumCulled = false;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(definitions.length * 3), 3);
            this.instancedMeshes.push(mesh);
            this.add(mesh);
        });

        this.instancedMeshes.forEach((mesh) => {
            const baseColor = mesh.material.userData.baseColor || new THREE.Color(0xffffff);
            for (let index = 0; index < definitions.length; index++) {
                mesh.setColorAt(index, baseColor);
            }
            mesh.instanceColor.needsUpdate = true;
        });

        if (this.showStatusLight) {
            this.createStatusLights(definitions.length);
        }
        if (this.optimization.contactShadow) {
            const shadow = createContactShadow(
                rootBox,
                definitions.length,
                `batch_${modelInfo.id}_contact_shadow`
            );
            this.contactShadowMesh = shadow.mesh;
            if (this.hasMirroredInstances) this.contactShadowMesh.scale.x = -1;
            this.contactShadowTexture = shadow.texture;
            this.add(this.contactShadowMesh);
        }
    }

    createStatusLights(count) {
        const geometry = new THREE.SphereGeometry(0.18, 10, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.name = `batch_${this.modelInfo.id}_status_lights`;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        this.statusLightMesh = mesh;
        this.add(mesh);
    }

    createProxy(definition, index) {
        const proxy = new BatchedDeviceProxy(definition, index, this, this.modelInfo, this.rootBox, this.options);
        this.proxies[index] = proxy;
        this.markInstanceDirty(index);
        if (this.showStatusLight) this.updateInstanceColor(index, STATUS_COLORS.idle);
        this.updateInstanceBodyState(index, 'bad');
        proxy.setConnectionBadge('bad');
        return proxy;
    }

    markInstanceDirty(index) {
        if (index < 0 || index >= this.definitions.length) return;
        this.dirtyIndexes.add(index);
    }

    markXRayDirty() {
        this.xRayDirty = true;
    }

    hasTransformChanged(index) {
        const proxy = this.proxies[index];
        const snapshot = this.transformSnapshots[index];
        if (!proxy || !snapshot) return false;

        return snapshot.visible !== proxy.visible
            || snapshot.detailActive !== proxy.detailActive
            || snapshot.px !== proxy.position.x
            || snapshot.py !== proxy.position.y
            || snapshot.pz !== proxy.position.z
            || snapshot.rx !== proxy.rotation.x
            || snapshot.ry !== proxy.rotation.y
            || snapshot.rz !== proxy.rotation.z
            || snapshot.sx !== proxy.scale.x
            || snapshot.sy !== proxy.scale.y
            || snapshot.sz !== proxy.scale.z;
    }

    rememberTransform(index) {
        const proxy = this.proxies[index];
        const snapshot = this.transformSnapshots[index];
        if (!proxy || !snapshot) return;

        snapshot.visible = proxy.visible;
        snapshot.detailActive = proxy.detailActive;
        snapshot.px = proxy.position.x;
        snapshot.py = proxy.position.y;
        snapshot.pz = proxy.position.z;
        snapshot.rx = proxy.rotation.x;
        snapshot.ry = proxy.rotation.y;
        snapshot.rz = proxy.rotation.z;
        snapshot.sx = proxy.scale.x;
        snapshot.sy = proxy.scale.y;
        snapshot.sz = proxy.scale.z;
    }

    updateInstanceState(index, data) {
        const quality = resolveDeviceQuality(data);
        this.updateInstanceBodyState(index, quality);
        if (!this.showStatusLight) return;
        const color = quality === 'bad'
            ? STATUS_COLORS.bad
            : quality === 'stale'
                ? STATUS_COLORS.stale
                : data.status?.alarm
                    ? STATUS_COLORS.alarm
                    : data.status?.running
                        ? STATUS_COLORS.running
                        : STATUS_COLORS.idle;
        this.updateInstanceColor(index, color);
    }

    updateInstanceBodyState(index, quality) {
        if (this.bodyQuality[index] === quality) return;
        this.bodyQuality[index] = quality;
        this.instancedMeshes.forEach((mesh) => {
            const baseColor = mesh.material.userData.baseColor || new THREE.Color(0xffffff);
            const color = baseColor.clone();
            if (quality === 'bad') {
                color.copy(BODY_COLORS.bad);
            } else if (quality === 'stale') {
                color.lerp(BODY_COLORS.stale, 0.35);
            }
            mesh.setColorAt(index, color);
            mesh.instanceColor.needsUpdate = true;
        });
    }

    updateInstanceColor(index, color) {
        if (!this.statusLightMesh) return;
        const colorHex = color.getHex();
        if (this.statusColorHexes[index] === colorHex) return;
        this.statusColorHexes[index] = colorHex;
        this.statusLightMesh.setColorAt(index, color);
        this.statusLightMesh.instanceColor.needsUpdate = true;
    }

    updateInstanceMatrix(index) {
        const proxy = this.proxies[index];
        if (!proxy) return;

        const visibleScale = proxy.visible && !proxy.detailActive ? 1 : 0;
        tempPosition.copy(proxy.position);
        tempQuaternion.setFromEuler(proxy.rotation);
        tempScale.copy(proxy.scale).multiplyScalar(visibleScale);
        tempMatrix.compose(tempPosition, tempQuaternion, tempScale);

        if (this.hasMirroredInstances) tempMatrix.premultiply(reflectionX);

        this.instancedMeshes.forEach(mesh => {
            mesh.setMatrixAt(index, tempMatrix);
        });
        if (this.contactShadowMesh) {
            this.contactShadowMesh.setMatrixAt(index, tempMatrix);
        }

        // Status markers are ordinary positive-handed spheres; their anchor
        // must still use the original device transform exactly once.
        if (this.hasMirroredInstances) tempMatrix.premultiply(reflectionX);

        if (this.statusLightMesh) {
            tempPosition.set(0, this.statusLightOffsets[index], 0).applyMatrix4(tempMatrix);
            tempScale.setScalar(visibleScale);
            tempMatrix.compose(tempPosition, identityQuaternion, tempScale);
            this.statusLightMesh.setMatrixAt(index, tempMatrix);
        }
        this.rememberTransform(index);
    }

    detectTransformChanges() {
        this.proxies.forEach((_, index) => {
            if (this.hasTransformChanged(index)) {
                this.markInstanceDirty(index);
                this.markXRayDirty();
            }
        });
    }

    flushMatrixUpdates() {
        if (this.dirtyIndexes.size === 0) return;

        this.dirtyIndexes.forEach(index => this.updateInstanceMatrix(index));
        this.dirtyIndexes.clear();

        this.instancedMeshes.forEach(mesh => {
            mesh.instanceMatrix.needsUpdate = true;
        });
        if (this.contactShadowMesh) this.contactShadowMesh.instanceMatrix.needsUpdate = true;
        if (this.statusLightMesh) this.statusLightMesh.instanceMatrix.needsUpdate = true;
    }

    reconcileXRayMode() {
        if (!this.xRayDirty) return;
        this.xRayDirty = false;
        if (!this.supportsXRay) return;
        const enable = this.proxies.some(proxy => proxy?.visible && proxy.xRayEnabled);
        if (this.lastXRayMode === enable) return;
        this.lastXRayMode = enable;
        this.instancedMeshes.forEach(mesh => {
            mesh.material.transparent = enable;
            mesh.material.opacity = enable ? 0.25 : 1;
            mesh.material.depthWrite = !enable;
            mesh.material.needsUpdate = true;
        });
    }

    update() {
        this.detectTransformChanges();
        this.flushMatrixUpdates();
        this.reconcileXRayMode();
    }

    dispose() {
        this.instancedMeshes.forEach(mesh => {
            mesh.geometry.dispose();
            mesh.material.dispose();
        });
        if (this.statusLightMesh) {
            this.statusLightMesh.geometry.dispose();
            this.statusLightMesh.material.dispose();
        }
        if (this.contactShadowMesh) {
            this.contactShadowMesh.geometry.dispose();
            this.contactShadowMesh.material.dispose();
            this.contactShadowTexture?.dispose?.();
        }
        this.proxies.forEach(proxy => proxy?.dispose?.());
    }
}

export async function createBatchedDeviceRenderer(modelInfo, definitions, options = {}) {
    const reflected = definitions.map(definition => shouldMirrorX(parseJson(definition.deviceCfg.instance_config, {})));
    if (reflected.some(Boolean) && !reflected.every(Boolean)) {
        throw new Error('镜像与非镜像实例不能共用一个实例绘制，请按镜像方向分组');
    }
    if (modelInfo.id === 'transfer_cart') {
        const { parts, rootBox } = createCompactTransferCartParts();
        const batchRenderer = new DeviceBatchRenderer(modelInfo, parts, rootBox, definitions, {
            ...options,
            showStatusLight: true,
            diagnostics: {
                sourceMeshCount: parts.length,
                staticPartCount: parts.length,
                mergedMeshCount: 0,
                animatedBindingCount: 0
            }
        });
        const deviceModels = definitions.map((definition, index) => batchRenderer.createProxy(definition, index));
        return { batchRenderer, deviceModels };
    }

    const root = await loadGltf(resolveBackendAssetUrl(modelInfo.file_path));
    const metadata = modelMetadata(modelInfo);
    const optimization = resolveModelOptimization(modelInfo);
    const bindings = Array.isArray(metadata.partBindings) ? metadata.partBindings : [];
    const bound = collectBoundObjects(root, metadata);
    if (bound.resolvedCount !== bindings.length) {
        throw new Error(`模型活动节点仅解析 ${bound.resolvedCount}/${bindings.length}，已回退到原始渲染`);
    }
    const { parts, rootBox, diagnostics } = collectMergedParts(root, bound.objects, optimization);
    const batchRenderer = new DeviceBatchRenderer(modelInfo, parts, rootBox, definitions, {
        ...options,
        diagnostics: {
            ...diagnostics,
            animatedBindingCount: bindings.length,
            animatedObjectCount: bound.objects.size
        }
    });
    const deviceModels = definitions.map((definition, index) => batchRenderer.createProxy(definition, index));
    if (bindings.length) {
        deviceModels.forEach(proxy => proxy.attachAnimatedRoot(root));
    }
    return { batchRenderer, deviceModels };
}
