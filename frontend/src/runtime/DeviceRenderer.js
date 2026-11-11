import * as THREE from 'three';
import { createDeviceModel } from '../three/ModelFactory.js';
import { setConnectionBadge3D } from './ConnectionBadge3D.js';
import { applyLayoutEditorAppearance } from './layoutEditorAppearance.js';

const OFFLINE_GRAY = new THREE.Color(0xa8b0b0);

function parseInstanceConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return {};
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

function makeMaterialsMirrorSafe(deviceModel) {
    deviceModel.traverse?.((child) => {
        if (!child.isMesh || !child.material) return;
        const materialList = Array.isArray(child.material) ? child.material : [child.material];
        materialList.filter(Boolean).forEach((material) => {
            if (material.userData?.mirrorSafeApplied) return;
            material.userData = {
                ...(material.userData || {}),
                mirrorSafeApplied: true,
                originalSide: material.side
            };
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
        });
    });
}

export async function createConfiguredDeviceModel(definition, models = [], options = {}) {
    const { deviceCfg } = definition;
    const deviceModel = await createDeviceModel(deviceCfg, models, options);
    if (options.renderProfile === 'layout-editor') applyLayoutEditorAppearance(deviceModel);
    applyConfiguredDeviceTransform(deviceModel, definition);
    applyDeviceConnectionVisual(deviceModel, 'bad');
    return deviceModel;
}

export function applyConfiguredDeviceTransform(deviceModel, definition) {
    if (!deviceModel || !definition?.deviceCfg) return false;
    const { deviceCfg, devIdx, wsIdx, gLineIdx } = definition;
    const instanceConfig = parseInstanceConfig(deviceCfg.instance_config);
    deviceModel.deviceConfig = deviceCfg;
    deviceModel.furnaceName = deviceCfg.name || deviceCfg.id || deviceModel.furnaceName;
    deviceModel.userData.instanceConfig = instanceConfig;

    deviceModel.position.set(
        numberOrDefault(deviceCfg.pos_x, (devIdx - 2) * 14),
        numberOrDefault(deviceCfg.pos_y, 0),
        numberOrDefault(deviceCfg.pos_z, -gLineIdx * 16 - wsIdx * 20)
    );

    const rotationY = Number(deviceCfg.rotation_y);
    if (Number.isFinite(rotationY)) deviceModel.rotation.y = rotationY;

    const defaultScale = deviceModel.userData?.defaultScale || 1;
    const configuredScale = numberOrDefault(deviceCfg.scale, 1);
    const instanceScale = Number(instanceConfig.scaleMultiplier || 1);
    const finalScale = defaultScale * configuredScale * (Number.isFinite(instanceScale) ? instanceScale : 1);
    const mirrorX = shouldMirrorX(instanceConfig);
    deviceModel.userData.mirrorX = mirrorX;
    if (mirrorX) {
        deviceModel.scale.set(-finalScale, finalScale, finalScale);
        makeMaterialsMirrorSafe(deviceModel);
    } else {
        deviceModel.scale.setScalar(finalScale);
    }

    if (deviceModel.labelAnchor && Number.isFinite(Number(instanceConfig.labelY))) {
        deviceModel.labelAnchor.position.y = Number(instanceConfig.labelY);
    }

    if (deviceModel.statusLight && Number.isFinite(Number(instanceConfig.statusLightY))) {
        deviceModel.statusLight.position.y = Number(instanceConfig.statusLightY);
    }

    deviceModel.updateMatrixWorld?.(true);
    deviceModel.batchRenderer?.markInstanceDirty?.(deviceModel.instanceIndex);
    return true;
}

export function applyRealtimeToDeviceModel(deviceModel, data) {
    if (!deviceModel || !data) return;
    deviceModel.updateData(data);
    deviceModel.userData.lastRealtimeAt = Date.now();
    deviceModel.userData.quality = resolveDeviceQuality(data);
    if (deviceModel.userData.renderedByBatch) return;
    applyDeviceConnectionVisual(deviceModel, deviceModel.userData.quality);
}

export function resolveDeviceQuality(data) {
    const groups = data?.quality || {};
    const values = Object.values(groups).flatMap(group => Object.values(group || {}));
    if (values.includes('bad')) return 'bad';
    if (values.includes('stale')) return 'stale';
    return 'good';
}

function collectVisualMaterials(deviceModel) {
    if (deviceModel.userData.connectionVisualMaterials) {
        return deviceModel.userData.connectionVisualMaterials;
    }

    const materials = [];
    const seen = new Set();
    deviceModel.traverse?.((child) => {
        if (!child.isMesh || !child.material) return;
        const materialList = Array.isArray(child.material) ? child.material : [child.material];
        materialList.filter(Boolean).forEach((material) => {
            if (seen.has(material.uuid)) return;
            seen.add(material.uuid);
            materials.push({
                material,
                color: material.color?.clone?.() || null,
                emissive: material.emissive?.clone?.() || null,
                map: material.map || null,
                opacity: material.opacity,
                transparent: material.transparent,
                depthWrite: material.depthWrite
            });
        });
    });
    deviceModel.userData.connectionVisualMaterials = materials;
    return materials;
}

function restoreVisualMaterials(deviceModel) {
    collectVisualMaterials(deviceModel).forEach((entry) => {
        if (entry.color && entry.material.color) entry.material.color.copy(entry.color);
        if (entry.emissive && entry.material.emissive) entry.material.emissive.copy(entry.emissive);
        if ('map' in entry.material) entry.material.map = entry.map;
        entry.material.opacity = entry.opacity;
        entry.material.transparent = entry.transparent;
        entry.material.depthWrite = entry.depthWrite;
        entry.material.needsUpdate = true;
    });
}

function applyOfflineGray(deviceModel) {
    collectVisualMaterials(deviceModel).forEach((entry) => {
        if (entry.material.color) {
            entry.material.color.copy(OFFLINE_GRAY);
        }
        if (entry.material.emissive) entry.material.emissive.setHex(0x000000);
        if ('map' in entry.material) entry.material.map = null;
        entry.material.opacity = 1;
        entry.material.transparent = false;
        entry.material.depthWrite = true;
        entry.material.needsUpdate = true;
    });
}

function setConnectionBadge(deviceModel, quality) {
    setConnectionBadge3D(deviceModel, quality);
}

export function applyDeviceConnectionVisual(deviceModel, quality) {
    if (!deviceModel) return;
    const nextQuality = quality || 'bad';
    deviceModel.userData.quality = nextQuality;
    if (deviceModel.userData.connectionVisualQuality === nextQuality) return;
    deviceModel.userData.connectionVisualQuality = nextQuality;

    if (nextQuality === 'bad') {
        applyOfflineGray(deviceModel);
    } else {
        restoreVisualMaterials(deviceModel);
    }
    setConnectionBadge(deviceModel, nextQuality);
}
