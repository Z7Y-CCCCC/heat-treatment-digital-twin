import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneObject3D } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FurnaceModel } from './FurnaceModel.js';
import { buildDeviceLabelMarkup, updateDeviceLabelElements, applyDeviceLabelStyle } from '../runtime/uiConfig.js';
import { getBackendOrigin } from '../runtime/backendEndpoint.js';
import { enhanceModelMaterial, resolveModelOptimization } from '../runtime/modelOptimization.js';
import { restoreGltfNodeNames } from './gltfNodeIdentity.js';

const loader = new GLTFLoader();
const modelCache = new Map();

export function resolveBackendAssetUrl(filePath) {
    if (!filePath) return '';
    if (/^https?:\/\//i.test(filePath)) return filePath;

    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    return `${getBackendOrigin()}${normalizedPath}`;
}

export function loadGltf(url) {
    if (!modelCache.has(url)) {
        const promise = new Promise((resolve, reject) => {
            loader.load(url, (gltf) => {
                restoreGltfNodeNames(gltf);
                const root = gltf.scene || gltf.scenes?.[0];
                if (!root) {
                    reject(new Error('模型文件中没有可用场景'));
                    return;
                }
                normalizeModelRoot(root);
                resolve(root);
            }, undefined, reject);
        });
        modelCache.set(url, promise);
    }
    return modelCache.get(url);
}

function normalizeModelRoot(root) {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.y -= box.min.y;
    root.position.z -= center.z;
}

function collectMaterials(object, targetSet, optimization) {
    object.traverse((child) => {
        if (!child.isMesh) return;

        child.castShadow = false;
        child.receiveShadow = false;

        if (Array.isArray(child.material)) {
            child.material = child.material.map((mat) => enhanceModelMaterial(mat.clone(), optimization));
            child.material.forEach((mat) => targetSet.add(mat));
        } else if (child.material) {
            child.material = enhanceModelMaterial(child.material.clone(), optimization);
            targetSet.add(child.material);
        }
    });
}

function resolveDeviceQuality(data) {
    const values = Object.values(data?.quality || {}).flatMap(group => Object.values(group || {}));
    if (values.includes('bad')) return 'bad';
    if (values.includes('stale')) return 'stale';
    return 'good';
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
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
    target.traverse?.((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
            if (material.color) material.color.copy(color);
            if (material.emissive) material.emissive.copy(color);
            material.needsUpdate = true;
        });
    });
}

class TransferCartModel extends THREE.Group {
    constructor(deviceConfig, options = {}) {
        super();
        this.deviceConfig = deviceConfig;
        this.furnaceId = deviceConfig.id;
        this.furnaceName = deviceConfig.name;
        this.userData.isDevice = true;
        this.userData.id = deviceConfig.id;
        this.userData.defaultScale = 1;
        const instanceConfig = parseJson(deviceConfig.instance_config, {});
        this.labelConfig = {
            ...(options.labelConfig || {}),
            ...(instanceConfig.labelConfig || {})
        };
        this.labelElements = new Map();
        this.lastLabelValues = new Map();
        this.lastRealtimeData = null;

        this.lastVisualState = null;

        this.createBody();
        this.createStatusLight();
        this.createLabel();
    }

    createBody() {
        const materials = {
            rail: new THREE.MeshLambertMaterial({ color: 0x2b3033 }),
            sleeper: new THREE.MeshLambertMaterial({ color: 0x4b5357 }),
            chassis: new THREE.MeshLambertMaterial({ color: 0x343b40 }),
            deck: new THREE.MeshLambertMaterial({ color: 0xb8c0c4 }),
            accent: new THREE.MeshLambertMaterial({ color: 0xd9a441 }),
            wheel: new THREE.MeshLambertMaterial({ color: 0x171a1c }),
            load: new THREE.MeshLambertMaterial({ color: 0x748087 })
        };
        this.materials = Object.values(materials);

        const addBox = (name, size, position, material) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
            mesh.name = name;
            mesh.position.set(...position);
            this.add(mesh);
            return mesh;
        };

        addBox('rail_left', [4.8, 0.08, 0.08], [0, 0.04, -0.86], materials.rail);
        addBox('rail_right', [4.8, 0.08, 0.08], [0, 0.04, 0.86], materials.rail);
        [-1.8, -0.9, 0, 0.9, 1.8].forEach((x) => {
            addBox('rail_sleeper', [0.16, 0.05, 2.05], [x, 0.01, 0], materials.sleeper);
        });

        addBox('cart_chassis', [2.9, 0.28, 1.42], [0, 0.42, 0], materials.chassis);
        addBox('cart_deck', [2.55, 0.16, 1.18], [0, 0.66, 0], materials.deck);
        addBox('cart_front_guard', [0.16, 0.74, 1.24], [1.35, 0.94, 0], materials.accent);
        addBox('cart_rear_guard', [0.16, 0.48, 1.24], [-1.35, 0.82, 0], materials.accent);
        addBox('cart_load_frame', [1.34, 0.34, 0.82], [-0.18, 0.93, 0], materials.load);

        const wheelGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.18, 14);
        [-0.95, 0.95].forEach((x) => {
            [-0.72, 0.72].forEach((z) => {
                const wheel = new THREE.Mesh(wheelGeometry, materials.wheel);
                wheel.name = 'cart_wheel';
                wheel.rotation.z = Math.PI / 2;
                wheel.position.set(x, 0.26, z);
                this.add(wheel);
            });
        });
    }

    createStatusLight() {
        const geometry = new THREE.SphereGeometry(0.12, 12, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0x666666 });
        this.statusLight = new THREE.Mesh(geometry, material);
        this.statusLight.position.set(1.18, 1.25, 0.48);
        this.add(this.statusLight);
    }

    createLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';
        applyDeviceLabelStyle(div, this.labelConfig);
        div.innerHTML = buildDeviceLabelMarkup(this.furnaceName, this.labelConfig, { isTransferCart: true, deviceId: this.furnaceId });
        div.querySelectorAll('[data-label-row]').forEach((valueEl) => {
            const key = valueEl.getAttribute('data-label-row');
            const unitEl = div.querySelector(`[data-label-unit="${key}"]`) || null;
            this.labelElements.set(key, { valueEl, unitEl });
        });

        this.labelObj = new CSS2DObject(div);
        this.labelObj.visible = false;
        this.labelDiv = div;

        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, 1.62, 0);
        this.add(this.labelAnchor);
        this.labelAnchor.add(this.labelObj);
    }

    setLabelVisible(visible) {
        const nextVisible = !!visible && this.labelConfig?.enabled !== false;
        if (this.labelObj) this.labelObj.visible = nextVisible;
        if (this.labelDiv) this.labelDiv.style.opacity = nextVisible ? '1' : '0';
    }

    setXRayMode(enable) {
        const opacity = enable ? 0.35 : 1;
        (this.materials || []).forEach((mat) => {
            mat.transparent = !!enable;
            mat.opacity = opacity;
            mat.depthWrite = !enable;
            mat.needsUpdate = true;
        });
    }

    updateData(data) {
        this.lastRealtimeData = data;
        updateDeviceLabelElements(
            this.labelElements,
            data || {},
            this.labelConfig,
            { isTransferCart: true },
            this.lastLabelValues
        );

        const stateText = data?.status?.running ? '??' : data?.status?.alarm ? '??' : '??';
        const quality = resolveDeviceQuality(data);
        const visualState = `${quality}:${stateText}`;
        if (this.lastVisualState === visualState) return;
        this.lastVisualState = visualState;

        const color = quality === 'bad'
            ? 0xd96060
            : quality === 'stale'
                ? 0xf0b35a
                : data?.status?.alarm
                    ? 0xff3333
                    : data?.status?.running
                        ? 0x00ff88
                        : 0x666666;
        this.statusLight.material.color.setHex(color);
    }

    update() {}

    dispose() {
        this.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose());
            } else if (child.material) {
                child.material.dispose();
            }
        });
    }
}

class ImportedDeviceModel extends THREE.Group {
    constructor(deviceConfig, modelInfo, options = {}) {
        super();
        this.deviceConfig = deviceConfig;
        this.modelInfo = modelInfo;
        this.metadata = modelMetadata(modelInfo);
        this.optimization = resolveModelOptimization(modelInfo);
        this.furnaceId = deviceConfig.id;
        this.furnaceName = deviceConfig.name;
        this.userData.isDevice = true;
        this.userData.id = deviceConfig.id;
        this.userData.defaultScale = Number(modelInfo.default_scale || 1);
        const instanceConfig = parseJson(deviceConfig.instance_config, {});
        this.labelConfig = {
            ...(options.labelConfig || {}),
            ...(instanceConfig.labelConfig || {})
        };
        this.labelElements = new Map();
        this.lastLabelValues = new Map();
        this.lastRealtimeData = null;

        this.materials = new Set();
        this.lastVisualState = null;
        this.xRayEnabled = null;
        this.partBindings = Array.isArray(this.metadata.partBindings) ? this.metadata.partBindings : [];
        this.bindingStates = [];
        if (this.metadata.runtime?.showStatusLight === true) {
            this.createStatusLight();
        }
        this.createLabel();
    }

    async load() {
        const url = resolveBackendAssetUrl(this.modelInfo.file_path);
        const cachedRoot = await loadGltf(url);
        const root = cloneObject3D(cachedRoot);

        collectMaterials(root, this.materials, this.optimization);
        this.modelRoot = root;
        this.nodePathMap = buildObjectPathMap(root);
        this.preparePartBindings();
        this.add(root);
        return this;
    }

    createStatusLight() {
        const geometry = new THREE.SphereGeometry(0.18, 16, 16);
        const material = new THREE.MeshStandardMaterial({
            color: 0x666666,
            emissive: 0x000000,
            emissiveIntensity: 0
        });
        this.statusLight = new THREE.Mesh(geometry, material);
        this.statusLight.position.set(0, 2.8, 0);
        this.add(this.statusLight);
    }

    createLabel() {
        const div = document.createElement('div');
        div.className = 'furnace-label';
        div.style.opacity = '0';
        div.style.transition = 'opacity 0.5s';
        applyDeviceLabelStyle(div, this.labelConfig);
        div.innerHTML = buildDeviceLabelMarkup(this.furnaceName, this.labelConfig, { isTransferCart: false, deviceId: this.furnaceId });
        div.querySelectorAll('[data-label-row]').forEach((valueEl) => {
            const key = valueEl.getAttribute('data-label-row');
            const unitEl = div.querySelector(`[data-label-unit="${key}"]`) || null;
            this.labelElements.set(key, { valueEl, unitEl });
        });

        this.labelObj = new CSS2DObject(div);
        this.labelObj.visible = false;
        this.labelDiv = div;

        this.labelAnchor = new THREE.Object3D();
        this.labelAnchor.position.set(0, 3.3, 0);
        this.add(this.labelAnchor);
        this.labelAnchor.add(this.labelObj);
    }

    setLabelVisible(visible) {
        const nextVisible = !!visible && this.labelConfig?.enabled !== false;
        if (this.labelObj) this.labelObj.visible = nextVisible;
        if (this.labelDiv) this.labelDiv.style.opacity = nextVisible ? '1' : '0';
    }

    setXRayMode(enable) {
        if (this.metadata.runtime?.allowXRay !== true) return;
        if (this.xRayEnabled === enable) return;
        this.xRayEnabled = enable;

        const opacity = enable ? 0.25 : 1;
        this.materials.forEach((mat) => {
            mat.transparent = enable;
            mat.opacity = opacity;
            mat.depthWrite = !enable;
            mat.needsUpdate = true;
        });
    }

    preparePartBindings() {
        this.bindingStates = this.partBindings.map((binding) => {
            const target = this.nodePathMap?.get(binding.node_path)
                || this.modelRoot?.getObjectByName(binding.node_name || binding.nodeName || '');
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

    updateData(data) {
        this.lastRealtimeData = data;
        updateDeviceLabelElements(
            this.labelElements,
            data || {},
            this.labelConfig,
            { isTransferCart: false },
            this.lastLabelValues
        );

        if (this.statusLight) {
            const deviceQuality = this.resolveDeviceQuality(data);
            const isAlarm = !!data.status?.alarm;
            const isRunning = !!data.status?.running;
            const visualState = `${deviceQuality}:${isAlarm}:${isRunning}`;
            if (this.lastVisualState !== visualState) {
                this.lastVisualState = visualState;

                if (deviceQuality === 'bad') {
                    this.statusLight.material.color.setHex(0xd96060);
                    this.statusLight.material.emissive.setHex(0xd96060);
                    this.statusLight.material.emissiveIntensity = 0.75;
                } else if (deviceQuality === 'stale') {
                    this.statusLight.material.color.setHex(0xf0b35a);
                    this.statusLight.material.emissive.setHex(0xf0b35a);
                    this.statusLight.material.emissiveIntensity = 0.55;
                } else if (isAlarm) {
                    this.statusLight.material.color.setHex(0xff3333);
                    this.statusLight.material.emissive.setHex(0xff3333);
                    this.statusLight.material.emissiveIntensity = 0.9;
                } else if (isRunning) {
                    this.statusLight.material.color.setHex(0x00ff88);
                    this.statusLight.material.emissive.setHex(0x00ff88);
                    this.statusLight.material.emissiveIntensity = 0.6;
                } else {
                    this.statusLight.material.color.setHex(0x666666);
                    this.statusLight.material.emissive.setHex(0x000000);
                    this.statusLight.material.emissiveIntensity = 0;
                }
            }
        }

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
                const factor = Number.isFinite(Number(binding.speed_factor)) ? Number(binding.speed_factor) : (Math.PI * 2 / 60);
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
                applyColorToTarget(target, toBool(rawValue) ? (binding.on_color || '#00ff88') : (binding.off_color || '#666666'));
            }
        });
    }

    resolveDeviceQuality(data) {
        return resolveDeviceQuality(data);
    }

    update(delta) {
        this.bindingStates.forEach((state) => {
            if (state.binding.action !== 'rotate_speed' || !state.speed) return;
            state.target.rotation[state.axis] += delta * state.speed;
        });
    }

    dispose() {
        this.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose());
            } else if (child.material) {
                child.material.dispose();
            }
        });
    }
}

function attachModelLoadError(model, deviceConfig, modelInfo, error, reason = '') {
    const url = modelInfo?.file_path ? resolveBackendAssetUrl(modelInfo.file_path) : ''
    model.userData.modelLoadError = {
        modelId: String(modelInfo?.id || deviceConfig?.model_type || ''),
        modelName: String(modelInfo?.name || deviceConfig?.name || deviceConfig?.model_type || '未命名模型'),
        url,
        reason: String(reason || error?.message || error || '未知模型加载错误')
    }
    return model
}

export async function createDeviceModel(deviceConfig, models = [], options = {}) {
    const modelInfo = models.find((item) => item.id === deviceConfig.model_type);
    if (deviceConfig.model_type === 'transfer_cart' && !modelInfo?.file_path) {
        return new TransferCartModel(deviceConfig, options);
    }

    if (!modelInfo || modelInfo.id === 'builtin_furnace' || !modelInfo.file_path) {
        if (modelInfo?.id === 'builtin_furnace' || deviceConfig.model_type === 'builtin_furnace') {
            return new FurnaceModel(deviceConfig.id, deviceConfig.name, { labelConfig: options.labelConfig, instanceConfig: parseJson(deviceConfig.instance_config, {}) });
        }
        return attachModelLoadError(
            new FurnaceModel(deviceConfig.id, deviceConfig.name, { labelConfig: options.labelConfig, instanceConfig: parseJson(deviceConfig.instance_config, {}) }),
            deviceConfig,
            modelInfo,
            null,
            !modelInfo
                ? `未找到模型资产：${deviceConfig.model_type || '未设置模型类型'}`
                : `模型资产未配置文件：${modelInfo.id}`
        );
    }

    try {
        return await new ImportedDeviceModel(deviceConfig, modelInfo, options).load();
    } catch (error) {
        console.warn(`[ModelFactory] 模型 ${modelInfo.id} 加载失败，回退到内置炉子模型:`, error);
        return attachModelLoadError(
            new FurnaceModel(deviceConfig.id, deviceConfig.name, { labelConfig: options.labelConfig, instanceConfig: parseJson(deviceConfig.instance_config, {}) }),
            deviceConfig,
            modelInfo,
            error
        );
    }
}
