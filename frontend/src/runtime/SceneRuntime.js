import { SceneManager } from '../three/SceneManager.js';
import { applyConfiguredDeviceTransform, applyRealtimeToDeviceModel, createConfiguredDeviceModel } from './DeviceRenderer.js';
import { createBatchedDeviceRenderer, getBatchableModelInfo } from './BatchDeviceRenderer.js';
import { shouldOptimizeModelGroup } from './modelOptimization.js';
import { deviceLocalToWorld, normalizeSpatialTransform } from '../utils/spatialLayout.js';

function parseInstanceConfig(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function numberOrDefault(value, fallback = 0) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

// 后台编排坐标与 Unity 共用同一套世界坐标，预览层不再额外拉伸 Z 轴。
const LINE_LAYOUT_Z_VISUAL_SCALE = 1;

function layoutOffsetToSceneZ(offsetZ) {
    return numberOrDefault(offsetZ, 0) * LINE_LAYOUT_Z_VISUAL_SCALE;
}

function isAuxiliaryDevice(deviceCfg) {
    const instanceConfig = parseInstanceConfig(deviceCfg?.instance_config);
    return deviceCfg?.model_type === 'transfer_cart'
        || instanceConfig.role === 'transfer_cart'
        || instanceConfig.role === 'auxiliary'
        || instanceConfig.sceneObject === true;
}

function normalizeLineLayoutItems(items, type) {
    const isRail = type === 'rail';
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            id: String(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`),
            name: String(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`),
            type: isRail ? 'cart_rail' : 'device_lane',
            offsetZ: numberOrDefault(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0),
            length: Math.max(1, numberOrDefault(item?.length, 60)),
            sort_order: numberOrDefault(item?.sort_order, index)
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
}

function getLineLayout(line) {
    const source = parseInstanceConfig(line?.layout || line?.layout_json) || {};
    const lanes = normalizeLineLayoutItems(source.lanes, 'lane');
    const rails = normalizeLineLayoutItems(source.rails, 'rail');
    const flowDirection = ['right', 'left', 'none'].includes(source.flowDirection) ? source.flowDirection : 'right';
    if (!lanes.length) {
        lanes.push({
            id: 'lane_1',
            name: '设备线 1',
            type: 'device_lane',
            offsetZ: 0,
            length: 60,
            sort_order: 0
        });
    }
    return {
        version: Number(source.version || 1),
        coordinateSpace: source.coordinateSpace || (Number(source.version || 0) >= 2 ? 'workshop_local' : 'legacy_world'),
        transform: normalizeSpatialTransform(source.transform),
        flowDirection,
        lanes,
        rails
    };
}

function lineUsesStructuredLayout(line) {
    const source = parseInstanceConfig(line?.layout || line?.layout_json) || {};
    return !!source.version || Array.isArray(source.lanes) || Array.isArray(source.rails);
}

function getLineBaseZ(globalLineIndex, line = null) {
    if (Number(getLineLayout(line).version || 0) >= 2) return 0;
    return -numberOrDefault(globalLineIndex, 0) * 16;
}

function nearestLayoutItem(items, relativeZ) {
    if (!items.length) return null;
    return [...items].sort((a, b) => (
        Math.abs(numberOrDefault(a.offsetZ, 0) - relativeZ)
        - Math.abs(numberOrDefault(b.offsetZ, 0) - relativeZ)
    ))[0];
}

function resolveDeviceLayoutTarget(deviceCfg, line, globalLineIndex, options = {}) {
    const layout = getLineLayout(line);
    const config = parseInstanceConfig(deviceCfg?.instance_config);
    const allowFallback = options.allowFallback !== false;
    const baseZ = getLineBaseZ(globalLineIndex, line);
    const relativeZ = (numberOrDefault(deviceCfg?.pos_z, baseZ) - baseZ) / LINE_LAYOUT_Z_VISUAL_SCALE;

    if (isAuxiliaryDevice(deviceCfg)) {
        if (config.railLineId === line?.id && config.railId) {
            const rail = layout.rails.find(item => item.id === config.railId);
            if (rail) return { type: 'rail', item: rail, explicit: true };
        }
        if (allowFallback && (config.railLineId === line?.id || deviceCfg?.line_id === line?.id) && layout.rails.length) {
            const rail = nearestLayoutItem(layout.rails, relativeZ);
            if (rail) return { type: 'rail', item: rail, explicit: false };
        }
        return null;
    }

    if (config.laneLineId === line?.id && config.laneId) {
        const lane = layout.lanes.find(item => item.id === config.laneId);
        if (lane) return { type: 'lane', item: lane, explicit: true };
    }

    if (allowFallback && deviceCfg?.line_id === line?.id && layout.lanes.length) {
        const lane = nearestLayoutItem(layout.lanes, relativeZ);
        if (lane) return { type: 'lane', item: lane, explicit: false };
    }

    return null;
}

function applyLineLayoutToDevice(deviceCfg, line, globalLineIndex, targetOverride = null) {
    const next = { ...deviceCfg };
    const config = { ...parseInstanceConfig(next.instance_config) };
    const target = targetOverride || resolveDeviceLayoutTarget(next, line, globalLineIndex, {
        allowFallback: !lineUsesStructuredLayout(line)
    });

    if (!target) {
        if (next.pos_z === undefined || next.pos_z === null || next.pos_z === '') {
            next.pos_z = getLineBaseZ(globalLineIndex, line);
        }
        return next;
    }

    next.pos_z = getLineBaseZ(globalLineIndex, line) + layoutOffsetToSceneZ(target.item.offsetZ);

    if (target.type === 'rail') {
        config.role = next.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary');
        config.workshop_id = line?.workshop_id || config.workshop_id || config.workshopId || '';
        config.railLineId = line?.id;
        config.railId = target.item.id;
        config.railName = target.item.name;
    } else {
        config.laneLineId = line?.id;
        config.laneId = target.item.id;
        config.laneName = target.item.name;
    }

    next.instance_config = config;
    return next;
}

function flattenDeviceDefinitions(workshops) {
    const definitions = [];
    let gLineIdx = 0;
    const lineIndexById = new Map();
    const lineById = new Map();

    workshops.forEach((ws, wsIdx) => {
        (ws.lines || []).forEach((line) => {
            lineIndexById.set(line.id, { wsIdx, gLineIdx });
            lineById.set(line.id, line);
            gLineIdx++;
        });
    });

    workshops.forEach((ws, wsIdx) => {
        const workshopLineIndexes = (ws.lines || [])
            .map(line => lineIndexById.get(line.id)?.gLineIdx)
            .filter(index => Number.isFinite(index));
        const fallbackLineIndex = workshopLineIndexes[0] ?? 0;

        (ws.lines || []).forEach((line) => {
            const lineInfo = lineIndexById.get(line.id) || { wsIdx, gLineIdx: fallbackLineIndex };
            const lineDevices = line.devices || [];
            lineDevices.forEach((deviceCfg, devIdx) => {
                const target = resolveDeviceLayoutTarget(deviceCfg, line, lineInfo.gLineIdx, {
                    allowFallback: !lineUsesStructuredLayout(line)
                });
                if (lineUsesStructuredLayout(line) && !target) return;
                const localDevice = applyLineLayoutToDevice(deviceCfg, line, lineInfo.gLineIdx, target);
                const worldTransform = deviceLocalToWorld(localDevice, ws, line);
                definitions.push({
                    deviceCfg: {
                        ...localDevice,
                        pos_x: worldTransform.x,
                        pos_y: worldTransform.y,
                        pos_z: worldTransform.z,
                        rotation_y: worldTransform.rotationY,
                        coordinate_space: 'factory_world'
                    },
                    devIdx,
                    wsIdx,
                    gLineIdx: lineInfo.gLineIdx,
                    lineId: line.id,
                    isLineMember: !isAuxiliaryDevice(deviceCfg)
                });
            });
        });

        (ws.devices || []).forEach((deviceCfg, devIdx) => {
            const config = parseInstanceConfig(deviceCfg.instance_config);
            const targetLineId = config.railLineId || deviceCfg.line_id || ws.lines?.[0]?.id || '';
            const targetLine = lineById.get(targetLineId) || ws.lines?.[0] || null;
            const lineInfo = lineIndexById.get(targetLine?.id) || { wsIdx, gLineIdx: fallbackLineIndex };
            const target = targetLine
                ? resolveDeviceLayoutTarget(deviceCfg, targetLine, lineInfo.gLineIdx, {
                    allowFallback: !lineUsesStructuredLayout(targetLine)
                })
                : null;
            if (targetLine && lineUsesStructuredLayout(targetLine) && !target) return;
            const localDevice = targetLine
                ? applyLineLayoutToDevice(deviceCfg, targetLine, lineInfo.gLineIdx, target)
                : deviceCfg;
            const worldTransform = deviceLocalToWorld(localDevice, ws, targetLine);
            definitions.push({
                deviceCfg: {
                    ...localDevice,
                    pos_x: worldTransform.x,
                    pos_y: worldTransform.y,
                    pos_z: worldTransform.z,
                    rotation_y: worldTransform.rotationY,
                    coordinate_space: 'factory_world'
                },
                devIdx,
                wsIdx,
                gLineIdx: lineInfo.gLineIdx,
                lineId: targetLine?.id || deviceCfg.line_id || '',
                isLineMember: false
            });
        });
    });

    return definitions;
}

function runtimeModelKey(deviceCfg, models = []) {
    const modelInfo = models.find(item => item.id === deviceCfg?.model_type);
    return JSON.stringify([
        deviceCfg?.model_type || '',
        deviceCfg?.model_file || '',
        deviceCfg?.template_id || '',
        modelInfo?.file_path || '',
        deviceCfg?.name || ''
    ]);
}

export class SceneRuntime {
    constructor(containerElement, options) {
        this.containerElement = containerElement;
        this.options = options;
        this.furnaces = new Map();
        this.modelErrors = [];
        this.sceneManager = null;
        this.disposed = false;
        this.startPromise = null;
        this.pendingModels = new Set();
    }

    start() {
        if (this.disposed) return Promise.resolve(this);
        if (!this.startPromise) {
            this.startPromise = this.initialize().catch(error => {
                this.dispose();
                throw error;
            });
        }
        return this.startPromise;
    }

    async initialize() {
        const {
            workshops,
            models,
            cameraMode,
            renderOptions,
            onLevelChange,
            onDeviceSelect,
            onDeviceRegistered,
            interactionOptions
        } = this.options;

        this.modelErrors = [];

        this.sceneManager = new SceneManager(
            this.containerElement,
            onLevelChange,
            onDeviceSelect,
            interactionOptions,
            renderOptions
        );

        const definitions = flattenDeviceDefinitions(workshops || []);
        const results = new Array(definitions.length);
        const batchGroups = new Map();

        definitions.forEach((definition, index) => {
            const modelInfo = getBatchableModelInfo(definition.deviceCfg, models || []);
            if (!modelInfo) return;
            const batchKey = `${modelInfo.id}:${modelInfo.file_path}`;
            if (!batchGroups.has(batchKey)) {
                batchGroups.set(batchKey, { modelInfo, items: [] });
            }
            batchGroups.get(batchKey).items.push({ definition, index });
        });

        const batchedIndexes = new Set();
        for (const group of batchGroups.values()) {
            if (!shouldOptimizeModelGroup(group.modelInfo, group.items.length)) continue;
            try {
                const batch = await createBatchedDeviceRenderer(
                    group.modelInfo,
                    group.items.map(item => item.definition),
                    { labelConfig: this.options.deviceLabelConfig || {} }
                );
                if (this.disposed) {
                    batch.batchRenderer.dispose();
                    return this;
                }
                this.sceneManager.addBatchRenderer(batch.batchRenderer);
                group.items.forEach((item, localIndex) => {
                    results[item.index] = {
                        ...item.definition,
                        deviceModel: batch.deviceModels[localIndex]
                    };
                    batchedIndexes.add(item.index);
                });
            } catch (error) {
                if (this.disposed) return this;
                console.warn(`[SceneRuntime] 模型 ${group.modelInfo.id} 自动优化失败，使用原始渲染:`, error);
            }
        }

        await Promise.all(definitions.map(async (definition, index) => {
            if (batchedIndexes.has(index)) return;
            const deviceModel = await createConfiguredDeviceModel(definition, models || [], { labelConfig: this.options.deviceLabelConfig || {} });
            if (this.disposed) {
                deviceModel.dispose?.();
                return;
            }
            this.pendingModels.add(deviceModel);
            results[index] = {
                ...definition,
                deviceModel
            };
        }));
        if (this.disposed) return this;

        results.forEach(({ deviceCfg, deviceModel, wsIdx, gLineIdx, lineId, isLineMember }) => {
            const diagnostic = deviceModel?.userData?.modelLoadError;
            if (diagnostic) {
                this.modelErrors.push({
                    device: deviceCfg?.name || deviceCfg?.id || '未命名设备',
                    deviceId: deviceCfg?.id || '',
                    model: diagnostic.modelName || deviceCfg?.model_type || '未命名模型',
                    modelId: diagnostic.modelId || deviceCfg?.model_type || '',
                    reason: diagnostic.reason || '未知模型加载错误',
                    url: diagnostic.url || ''
                });
            }
            Object.assign(deviceModel.userData, {
                workshopIdx: wsIdx,
                globalLineIndex: gLineIdx,
                lineId,
                isLineMember,
                runtimeModelKey: runtimeModelKey(deviceCfg, models || [])
            });
            this.sceneManager.addFurnace(deviceModel);
            this.pendingModels.delete(deviceModel);
            this.furnaces.set(deviceCfg.id, deviceModel);
            if (onDeviceRegistered) onDeviceRegistered(deviceCfg);
        });

        this.sceneManager.setTopologyConfig(workshops || [], cameraMode || 'auto');
        this.sceneManager.animate();
        return this;
    }

    getModelErrors() {
        return this.modelErrors.slice();
    }

    updateDeviceLayout(workshops, deviceId, models = this.options.models || []) {
        const definition = flattenDeviceDefinitions(workshops || [])
            .find(item => String(item.deviceCfg?.id || '') === String(deviceId || ''));
        const deviceModel = this.furnaces.get(deviceId);
        if (!definition || !deviceModel) return false;
        if (deviceModel.userData.runtimeModelKey !== runtimeModelKey(definition.deviceCfg, models)) return false;

        applyConfiguredDeviceTransform(deviceModel, definition);
        Object.assign(deviceModel.userData, {
            workshopIdx: definition.wsIdx,
            globalLineIndex: definition.gLineIdx,
            lineId: definition.lineId,
            isLineMember: definition.isLineMember
        });
        this.sceneManager?.requestLabelRefresh?.(300);
        return true;
    }

    isRenderSurfaceHealthy() {
        return this.sceneManager?.isRenderSurfaceHealthy?.() === true;
    }

    applyDeviceData(data) {
        const deviceModel = this.furnaces.get(data?.furnace_id);
        applyRealtimeToDeviceModel(deviceModel, data);
    }

    flyToFactory() {
        this.sceneManager?.flyToFactory();
    }

    flyToWorkshop(index) {
        this.sceneManager?.flyToWorkshop(index);
    }

    flyToLine(index) {
        this.sceneManager?.flyToLine(index);
    }

    goUp() {
        this.sceneManager?.goUp();
    }

    controlCamera(action) {
        if (!this.sceneManager) return;
        switch (action) {
            case 'rotateLeft':
                this.sceneManager.rotateCamera(Math.PI / 8);
                break;
            case 'rotateRight':
                this.sceneManager.rotateCamera(-Math.PI / 8);
                break;
            case 'zoomIn':
                this.sceneManager.zoomCamera(true);
                break;
            case 'zoomOut':
                this.sceneManager.zoomCamera(false);
                break;
            default:
                break;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.pendingModels.forEach(model => model.dispose?.());
        this.pendingModels.clear();
        this.sceneManager?.dispose();
        this.sceneManager = null;
        this.furnaces.clear();
    }
}
