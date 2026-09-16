const express = require('express');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { getDb, getDbStatus } = require('../db/database');
const { isLoopbackAddress } = require('../middleware/security');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');
const {
    loadDesignerState,
    saveDraft,
    publishDraft
} = require('../services/dashboardDocuments');
const { mergeBuiltinModels } = require('../services/builtinModels');
const { getHeatTreatmentTemplatePacks } = require('../services/heatTreatmentTemplates');
const { getInspectionPresets } = require('../services/inspectionPresets');
const { normalizeInspection, validateInspection } = require('../../shared/inspectionConfig.cjs');
const { normalizeModelMetadata, stringifyModelMetadata } = require('../services/modelAssetMetadata');
const { getLicenseStatus } = require('../services/license');
const { saveDataSource, testDataSource } = require('../services/dataSources');

const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = {
    name: 'digital-twin-control-mcp',
    version: '1.0.0'
};

function safeTokenEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function suppliedToken(req) {
    const direct = String(req.get('x-mcp-token') || '');
    if (direct) return direct;
    const authorization = String(req.get('authorization') || '');
    return authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
}

function isAuthorized(req) {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
    const mcpToken = String(process.env.MCP_API_TOKEN || '');
    const adminToken = String(process.env.ADMIN_API_TOKEN || '');
    return (!!mcpToken && safeTokenEqual(suppliedToken(req), mcpToken))
        || (!!adminToken && safeTokenEqual(req.get('x-admin-token') || suppliedToken(req), adminToken));
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        return fallback;
    }
}

function text(value, fallback = '') {
    const result = String(value ?? fallback).trim();
    return result;
}

function identifier(value, label, max = 128) {
    const result = text(value);
    if (!result || result.length > max || !/^[a-zA-Z0-9_-]+$/.test(result)) {
        throw new Error(`${label}只能使用字母、数字、下划线和短横线，长度不超过 ${max}`);
    }
    return result;
}

function numberOr(value, fallback) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function boolOr(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).toLowerCase());
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergePlain(base, patch) {
    const output = isPlainObject(base) ? clone(base) : {};
    if (!isPlainObject(patch)) return output;
    for (const [key, value] of Object.entries(patch)) {
        if (isPlainObject(value) && isPlainObject(output[key])) output[key] = mergePlain(output[key], value);
        else output[key] = clone(value);
    }
    return output;
}

function modelIdentifier(value) {
    return identifier(value, '模型 ID', 160);
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity, fallback } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`${label}必须是数字`);
    }
    if (number < min || number > max) throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
    return number;
}

function toolDefinitions() {
    return [
        {
            name: 'get_project_state',
            description: '读取当前数字孪生项目的车间、产线、设备、点位、模型、运行状态和大屏设计稿。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'get_model_inspection',
            description: '读取模型的完整拆解编排：外壳、部件节点、位移/旋转、动画时序、镜头、标签、PLC/数据库部件绑定以及模型优化元数据。不修改配置。省略 modelId 时返回全部模型。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string', description: '模型 ID；省略时读取全部模型' },
                    includeMetadata: { type: 'boolean', description: '是否同时返回完整模型元数据，默认 true' }
                },
                additionalProperties: false
            }
        },
        {
            name: 'get_model_inspection_presets',
            description: '读取软件内置的模型拆解配置模板。模板包含部件分组、节点、偏移、镜头和数据关联示例，不修改当前模型。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string', description: '只读取指定模型的模板；省略时返回全部模板' }
                },
                additionalProperties: false
            }
        },
        {
            name: 'apply_model_inspection_preset',
            description: '把软件内置模板应用到指定模型，只替换 inspection 拆解编排并保留其它模型元数据；保存后通知 Unity 热加载。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    presetId: { type: 'string', description: '来自 get_model_inspection_presets 的模板 ID' }
                },
                required: ['modelId', 'presetId'],
                additionalProperties: false
            }
        },
        {
            name: 'validate_model_inspection',
            description: '校验模型拆解配置的结构、重复部件 ID、空节点目标、外壳/部件重叠和数量限制。不写入数据库；当前 MCP 校验无法读取 GLB 节点清单时会明确返回警告。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    inspection: { type: 'object', description: '可选：校验这份临时配置；省略时校验数据库中的当前配置' }
                },
                required: ['modelId'],
                additionalProperties: false
            }
        },
        {
            name: 'save_model_inspection',
            description: '完整替换一个模型的拆解配置并通知 Unity 热加载。适合一次性保存外壳、镜头、动画和全部部件；其它模型元数据会保留。保存前会执行结构校验。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    inspection: { type: 'object' }
                },
                required: ['modelId', 'inspection'],
                additionalProperties: false
            }
        },
        {
            name: 'update_model_inspection',
            description: '增量修改一个模型的拆解配置并通知 Unity 热加载。可同时修改顶层参数/镜头/外壳、单个部件、部件顺序、添加/删除部件，避免每次复制整份配置。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    patch: { type: 'object', description: '拆解配置的增量字段，例如 playback_speed、shell、exploded、labels' },
                    partUpdates: { type: 'array', description: '按 id 修改部件；元素格式为 {id, patch, remove?}' },
                    addParts: { type: 'array', description: '追加标准化部件对象，必须包含 id 和 node_path/node_name/node_paths/node_names 之一' },
                    removePartIds: { type: 'array', items: { type: 'string' } },
                    order: { type: 'array', items: { type: 'string' }, description: '部件完整新顺序，必须覆盖当前全部部件 ID' }
                },
                required: ['modelId'],
                additionalProperties: false
            }
        },
        {
            name: 'apply_model_inspection_layout',
            description: '快速调整一个模型的部件拆解布局并通知 Unity。scale 会按比例放大/缩小现有部件偏移，默认保留高度；grid 会按当前配置生成稳定的二维网格。适合快速修正“太散/太挤”，不会复制组件。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    strategy: { type: 'string', enum: ['scale', 'grid'], description: 'scale=相对当前布局缩放；grid=按部件顺序重新排成网格' },
                    spacing: { type: 'number', minimum: 0.1, maximum: 5, description: '布局倍率，默认 1；scale 下 1 不改变布局' },
                    includeY: { type: 'boolean', description: 'scale 是否同时缩放 Y 高度，默认 false' },
                    preserveGround: { type: 'boolean', description: '是否把最低部件抬到地面以上，默认 true' }
                },
                required: ['modelId'],
                additionalProperties: false
            }
        },
        {
            name: 'update_model_part_bindings',
            description: '维护模型部件与 PLC/数据库点位的关联。replace 整组替换，merge 按 binding id 增量合并；保存后 Unity 会重新加载通用动画/状态绑定。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    mode: { type: 'string', enum: ['replace', 'merge'], description: '默认 replace' },
                    bindings: { type: 'array' }
                },
                required: ['modelId', 'bindings'],
                additionalProperties: false
            }
        },
        {
            name: 'update_model_metadata',
            description: '增量维护模型的全部可编辑元数据：assetSpec 交付规范、optimization 优化策略、inspection 拆解、partBindings 点位绑定、acceptance/release 状态和 runtime 运行开关。保存后通知 Unity。',
            inputSchema: {
                type: 'object',
                properties: {
                    modelId: { type: 'string' },
                    patch: { type: 'object' }
                },
                required: ['modelId', 'patch'],
                additionalProperties: false
            }
        },
        {
            name: 'set_data_mode',
            description: '切换数据引擎到 simulation（演示/验收）或 integrated_plc（现场 PLC），并可设置模拟轮询周期。',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['simulation', 'integrated_plc'] },
                    simulationIntervalMs: { type: 'integer', minimum: 250, maximum: 60000 }
                },
                required: ['mode'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_workshop',
            description: '创建或更新车间及其空间边界。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    sortOrder: { type: 'number' },
                    layout: { type: 'object' }
                },
                required: ['id', 'name'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_line',
            description: '创建或更新产线、设备线和导轨布局。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    workshopId: { type: 'string' },
                    sortOrder: { type: 'number' },
                    layout: { type: 'object' }
                },
                required: ['id', 'name', 'workshopId'],
                additionalProperties: false
            }
        },
        {
            name: 'upsert_device',
            description: '创建或更新设备实例、模型、空间坐标和 PLC 连接参数。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    lineId: { type: ['string', 'null'] },
                    modelType: { type: 'string' },
                    instanceConfig: { type: 'object' },
                    position: { type: 'object' },
                    rotationY: { type: 'number' },
                    scale: { type: 'number' },
                    sortOrder: { type: 'number' },
                    plcEnabled: { type: 'boolean' },
                    plcIp: { type: 'string' },
                    plcPort: { type: 'number' }
                },
                required: ['id', 'name'],
                additionalProperties: false
            }
        },
        {
            name: 'sync_device_points',
            description: '以整组方式保存一台设备的只读 PLC 点位。',
            inputSchema: {
                type: 'object',
                properties: {
                    deviceId: { type: 'string' },
                    points: { type: 'array' }
                },
                required: ['deviceId', 'points'],
                additionalProperties: false
            }
        },
        {
            name: 'save_dashboard_draft',
            description: '保存低代码设计器的完整大屏草稿，可修改多级设备视角、组件显隐和部件详情面板。',
            inputSchema: {
                type: 'object',
                properties: {
                    sceneId: { type: 'string' },
                    document: { type: 'object' },
                    expectedRevision: { type: 'integer' }
                },
                required: ['document'],
                additionalProperties: false
            }
        },
        {
            name: 'publish_dashboard',
            description: '发布当前场景草稿为可运行版本。',
            inputSchema: {
                type: 'object',
                properties: {
                    sceneId: { type: 'string' },
                    version: { type: 'string' },
                    notes: { type: 'string' }
                },
                additionalProperties: false
            }
        },
        {
            name: 'configure_demo_site',
            description: '幂等创建一套南区热处理示范车间：两条产线、三台设备、关键点位、模拟数据和多级设备巡检大屏，并发布运行版本。',
            inputSchema: {
                type: 'object',
                properties: {
                    publish: { type: 'boolean', description: '是否在保存草稿后立即发布，默认 true' },
                    simulationIntervalMs: { type: 'integer', minimum: 250, maximum: 60000 }
                },
                additionalProperties: false
            }
        },
        {
            name: 'run_acceptance_checks',
            description: '执行受控验收：数据库、运行引擎、空间层级、设备模型、四级视角和部件详情绑定检查。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'get_heat_treatment_template_library',
            description: '读取热处理数字孪生模板库：设备模板、只读点位包、展示报警规则、模型部件绑定和外部业务数据区块。不会修改现场配置。',
            inputSchema: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['furnace', 'washer'] }
                },
                additionalProperties: false
            }
        },
        {
            name: 'configure_readonly_business_source',
            description: '测试并保存排产/生产系统的外部只读数据库连接，可自动把当前业务摘要组件绑定到该数据源；不会向外部数据库写入。',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '数据源 ID' },
                    name: { type: 'string', description: '数据源名称' },
                    type: { type: 'string', enum: ['mysql', 'postgres', 'sqlserver', 'sqlite'] },
                    host: { type: 'string' },
                    port: { type: 'integer' },
                    user: { type: 'string' },
                    password: { type: 'string' },
                    database: { type: 'string' },
                    filename: { type: 'string' },
                    enabled: { type: 'boolean' },
                    bindBusinessWidgets: { type: 'boolean', description: '是否自动绑定当前排产业务摘要组件，默认 true' }
                },
                required: ['id', 'name', 'type'],
                additionalProperties: false
            }
        },
        {
            name: 'get_license_status',
            description: '读取离线许可证状态、客户、有效期和授权功能，不会修改许可证。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: 'install_license',
            description: '安装已由交付方签名的离线许可证；公钥校验失败时拒绝写入。',
            inputSchema: {
                type: 'object',
                properties: { license: { type: 'object' } },
                required: ['license'],
                additionalProperties: false
            }
        },
        {
            name: 'get_release_status',
            description: '读取当前发布版本、离线升级包签名/哈希要求和回滚流程，不会执行升级。',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        }
    ];
}

function result(value) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false
    };
}

function errorResult(message) {
    return {
        content: [{ type: 'text', text: String(message) }],
        isError: true
    };
}

function rpcResult(id, value) {
    return { jsonrpc: '2.0', id, result: value };
}

function rpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function createMcpRouter({ port = 3001 } = {}) {
    const router = express.Router();
    const requestAuthorization = new AsyncLocalStorage();

    router.use((req, res, next) => {
        if (!isAuthorized(req)) {
            res.status(403).json({ success: false, error: 'MCP 接口仅允许本机访问；远程访问需配置 MCP_API_TOKEN' });
            return;
        }
        const headers = {};
        for (const name of ['authorization', 'x-admin-token', 'x-mcp-token', 'cookie', 'x-csrf-token']) {
            if (req.get(name)) headers[name] = req.get(name);
        }
        requestAuthorization.run(headers, next);
    });

    async function localApi(path, options = {}) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            ...options,
            headers: {
                'content-type': 'application/json',
                ...(requestAuthorization.getStore() || {}),
                ...(options.headers || {})
            }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `内部接口 ${path} 返回 ${response.status}`);
        return body;
    }

    async function loadModels() {
        const db = await getDb();
        const rows = await db.all('SELECT * FROM models ORDER BY id ASC');
        return mergeBuiltinModels(rows);
    }

    async function loadModel(modelId) {
        const id = modelIdentifier(modelId);
        const model = (await loadModels()).find(item => item.id === id);
        if (!model) throw new Error(`模型不存在：${id}`);
        return {
            model,
            metadata: normalizeModelMetadata(model.metadata, { name: model.name })
        };
    }

    function modelSummary(model) {
        return {
            id: model.id,
            name: model.name,
            file_path: model.file_path,
            asset_type: model.asset_type,
            is_builtin: !!model.is_builtin,
            tags: parseJson(model.tags, []),
            thumbnail: model.thumbnail || null,
            default_scale: Number(model.default_scale || 1)
        };
    }

    async function saveModelMetadata(modelId, metadata) {
        const { model } = await loadModel(modelId);
        if (!isPlainObject(metadata)) throw new Error('模型元数据必须是对象');
        const normalized = normalizeModelMetadata(metadata, { name: model.name });
        const serialized = stringifyModelMetadata(normalized, { name: model.name });
        const saved = await localApi(`/api/models/${encodeURIComponent(model.id)}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: model.name,
                tags: model.tags || '[]',
                default_scale: Number(model.default_scale || 1),
                metadata: serialized
            })
        });
        return {
            success: true,
            model: modelSummary(saved.model || model),
            metadata: normalizeModelMetadata(saved.model?.metadata || serialized, { name: model.name }),
            unityNotified: true
        };
    }

    function normalizePartId(value) {
        const id = text(value);
        if (!id || id.length > 160) throw new Error('部件 ID 不能为空且长度不能超过 160');
        return id;
    }

    function patchInspectionParts(currentInspection, args = {}) {
        let next = clone(normalizeInspection(currentInspection));
        const removeIds = new Set((Array.isArray(args.removePartIds) ? args.removePartIds : []).map(normalizePartId));
        if (removeIds.size) next.parts = next.parts.filter(part => !removeIds.has(part.id));

        for (const item of Array.isArray(args.partUpdates) ? args.partUpdates : []) {
            if (!isPlainObject(item)) throw new Error('partUpdates 的每一项必须是对象');
            const id = normalizePartId(item.id);
            const index = next.parts.findIndex(part => part.id === id);
            if (item.remove === true) {
                if (index >= 0) next.parts.splice(index, 1);
                continue;
            }
            if (index < 0) throw new Error(`部件不存在：${id}；新增部件请使用 addParts`);
            const explicitPatch = isPlainObject(item.patch)
                ? item.patch
                : Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'remove'].includes(key)));
            next.parts[index] = mergePlain(next.parts[index], explicitPatch);
        }

        for (const part of Array.isArray(args.addParts) ? args.addParts : []) {
            if (!isPlainObject(part)) throw new Error('addParts 的每一项必须是对象');
            const id = normalizePartId(part.id);
            if (next.parts.some(item => item.id === id)) throw new Error(`部件 ID 已存在：${id}`);
            next.parts.push({ ...part, id });
        }

        if (args.order !== undefined) {
            if (!Array.isArray(args.order)) throw new Error('order 必须是部件 ID 数组');
            const order = args.order.map(normalizePartId);
            const currentIds = next.parts.map(part => part.id);
            if (order.length !== currentIds.length || new Set(order).size !== order.length
                || currentIds.some(id => !order.includes(id))) {
                throw new Error('order 必须完整覆盖修改后的全部部件 ID，且不能重复');
            }
            const byId = new Map(next.parts.map(part => [part.id, part]));
            next.parts = order.map(id => byId.get(id));
        }

        if (isPlainObject(args.patch)) next = mergePlain(next, args.patch);
        return normalizeInspection(next);
    }

    function applyInspectionLayout(currentInspection, args = {}) {
        const strategy = text(args.strategy || 'scale').toLowerCase();
        if (!['scale', 'grid'].includes(strategy)) throw new Error('strategy 只能是 scale 或 grid');
        const spacing = finiteNumber(args.spacing === undefined ? 1 : args.spacing, 'spacing', { min: 0.1, max: 5 });
        const includeY = boolOr(args.includeY, false);
        const preserveGround = boolOr(args.preserveGround, true);
        const next = clone(normalizeInspection(currentInspection));
        const parts = next.parts;

        if (strategy === 'scale') {
            for (const part of parts) {
                const offset = part.explode_offset || [0, 0, 0];
                part.explode_offset = [
                    Number(offset[0] || 0) * spacing,
                    Number(offset[1] || 0) * (includeY ? spacing : 1),
                    Number(offset[2] || 0) * spacing
                ];
            }
        } else if (parts.length) {
            const columns = Math.max(1, Math.ceil(Math.sqrt(parts.length)));
            const rows = Math.max(1, Math.ceil(parts.length / columns));
            const maxAbsX = Math.max(1, ...parts.map(part => Math.abs(Number(part.explode_offset?.[0] || 0))));
            const maxAbsZ = Math.max(1, ...parts.map(part => Math.abs(Number(part.explode_offset?.[2] || 0))));
            const cellX = columns > 1 ? (maxAbsX * 2) / (columns - 1) : maxAbsX;
            const cellZ = rows > 1 ? (maxAbsZ * 2) / (rows - 1) : maxAbsZ;
            parts.forEach((part, index) => {
                const column = index % columns;
                const row = Math.floor(index / columns);
                const offset = part.explode_offset || [0, 0, 0];
                part.explode_offset = [
                    (column - (columns - 1) / 2) * cellX * spacing,
                    Number(offset[1] || 0),
                    (row - (rows - 1) / 2) * cellZ * spacing
                ];
            });
        }

        if (preserveGround && parts.length) {
            const minY = Math.min(...parts.map(part => Number(part.explode_offset?.[1] || 0)));
            if (minY < 0) {
                const lift = -minY + 0.05;
                parts.forEach(part => { part.explode_offset[1] += lift; });
            }
        }
        return normalizeInspection(next);
    }

    async function getModelInspection(args = {}) {
        const includeMetadata = args.includeMetadata !== false;
        const models = args.modelId === undefined
            ? await loadModels()
            : [(await loadModel(args.modelId)).model];
        const items = models.map(model => {
            const metadata = normalizeModelMetadata(model.metadata, { name: model.name });
            const inspection = normalizeInspection(metadata.inspection, metadata.partBindings);
            const validation = validateInspection(inspection, []);
            return {
                model: modelSummary(model),
                inspection,
                partBindings: metadata.partBindings,
                validation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings },
                ...(includeMetadata ? { metadata } : {})
            };
        });
        return { success: true, count: items.length, models: items };
    }

    async function getModelInspectionPresets(args = {}) {
        const requested = args.modelId === undefined ? '' : modelIdentifier(args.modelId);
        const presets = getInspectionPresets().filter(preset => !requested || preset.modelId === requested);
        return { success: true, readOnly: true, count: presets.length, presets };
    }

    async function applyModelInspectionPreset(args = {}) {
        const loaded = await loadModel(args.modelId);
        const presetId = text(args.presetId);
        if (!presetId) throw new Error('presetId 不能为空');
        const preset = getInspectionPresets().find(item => item.id === presetId && item.modelId === loaded.model.id);
        if (!preset) throw new Error(`找不到模型 ${loaded.model.id} 对应的拆解模板：${presetId}`);
        const validation = validateInspection(preset.inspection, []);
        if (!validation.valid) throw new Error(`内置拆解模板不合法：${validation.errors.map(item => item.message).join('；')}`);
        return await saveModelMetadata(loaded.model.id, { ...loaded.metadata, inspection: preset.inspection });
    }

    async function validateModelInspection(args = {}) {
        const loaded = await loadModel(args.modelId);
        const inspection = args.inspection === undefined
            ? loaded.metadata.inspection
            : args.inspection;
        if (!isPlainObject(inspection)) throw new Error('inspection 必须是对象');
        const validation = validateInspection(inspection, []);
        return {
            success: true,
            model: modelSummary(loaded.model),
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
            inspection: validation.config
        };
    }

    async function saveModelInspection(args = {}) {
        const loaded = await loadModel(args.modelId);
        if (!isPlainObject(args.inspection)) throw new Error('inspection 必须是对象');
        const validation = validateInspection(args.inspection, []);
        if (!validation.valid) throw new Error(`拆解配置不合法：${validation.errors.map(item => item.message).join('；')}`);
        return await saveModelMetadata(loaded.model.id, { ...loaded.metadata, inspection: args.inspection });
    }

    async function updateModelInspection(args = {}) {
        const loaded = await loadModel(args.modelId);
        const inspection = patchInspectionParts(loaded.metadata.inspection, args);
        const validation = validateInspection(inspection, []);
        if (!validation.valid) throw new Error(`拆解配置不合法：${validation.errors.map(item => item.message).join('；')}`);
        return await saveModelMetadata(loaded.model.id, { ...loaded.metadata, inspection });
    }

    async function applyModelInspectionLayout(args = {}) {
        const loaded = await loadModel(args.modelId);
        const inspection = applyInspectionLayout(loaded.metadata.inspection, args);
        const validation = validateInspection(inspection, []);
        if (!validation.valid) throw new Error(`拆解配置不合法：${validation.errors.map(item => item.message).join('；')}`);
        return await saveModelMetadata(loaded.model.id, { ...loaded.metadata, inspection });
    }

    async function updateModelPartBindings(args = {}) {
        const loaded = await loadModel(args.modelId);
        if (!Array.isArray(args.bindings)) throw new Error('bindings 必须是数组');
        const mode = text(args.mode || 'replace').toLowerCase();
        if (!['replace', 'merge'].includes(mode)) throw new Error('mode 只能是 replace 或 merge');
        let bindings = args.bindings;
        if (mode === 'merge') {
            const byId = new Map((loaded.metadata.partBindings || []).map((binding, index) => [String(binding.id || `binding_${index + 1}`), binding]));
            for (const binding of args.bindings) {
                if (!isPlainObject(binding)) throw new Error('bindings 的每一项必须是对象');
                const id = String(binding.id || '');
                if (!id) throw new Error('merge 模式下每个 binding 都必须有 id');
                byId.set(id, mergePlain(byId.get(id) || {}, binding));
            }
            bindings = [...byId.values()];
        }
        return await saveModelMetadata(loaded.model.id, { ...loaded.metadata, partBindings: bindings });
    }

    async function updateModelMetadata(args = {}) {
        const loaded = await loadModel(args.modelId);
        if (!isPlainObject(args.patch)) throw new Error('patch 必须是对象');
        return await saveModelMetadata(loaded.model.id, mergePlain(loaded.metadata, args.patch));
    }

    async function loadState() {
        const db = await getDb();
        const [workshops, lines, devices, points, models, settings, designer] = await Promise.all([
            db.all('SELECT * FROM workshops ORDER BY sort_order ASC, id ASC'),
            db.all('SELECT * FROM `lines` ORDER BY sort_order ASC, id ASC'),
            db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC, id ASC'),
            db.all('SELECT * FROM data_points ORDER BY device_id, id ASC'),
            db.all('SELECT * FROM models ORDER BY id ASC'),
            db.all('SELECT * FROM settings ORDER BY `key` ASC'),
            loadDesignerState(db)
        ]);
        const settingsObject = {};
        settings.forEach(row => { settingsObject[row.key] = row.value; });
        return {
            db: getDbStatus(),
            engine: global.dataEngine?.getStatus?.() || null,
            settings: settingsObject,
            workshops: workshops.map(row => ({ ...row, layout: normalizeWorkshopLayout(row.layout_json) })),
            lines: lines.map(row => ({ ...row, layout: normalizeLineLayout(row.layout_json) })),
            devices,
            dataPoints: points,
            models: mergeBuiltinModels(models).map(model => ({
                id: model.id,
                name: model.name,
                file_path: model.file_path,
                asset_type: model.asset_type,
                is_builtin: !!model.is_builtin,
                metadata: parseJson(model.metadata, {})
            })),
            designer: {
                project: designer.project,
                scene: designer.scene,
                revision: designer.revision,
                document: designer.document,
                releases: designer.releases,
                currentRelease: designer.currentRelease
            }
        };
    }

    async function upsertWorkshop(args) {
        const id = identifier(args.id, '车间 ID', 64);
        const name = text(args.name);
        if (!name) throw new Error('车间名称不能为空');
        const db = await getDb();
        const layout = normalizeWorkshopLayout(args.layout);
        await db.upsert('workshops', {
            id,
            name,
            sort_order: numberOr(args.sortOrder, 0),
            layout_json: JSON.stringify(layout)
        }, 'id');
        return { success: true, workshop: await db.get('SELECT * FROM workshops WHERE id = ?', [id]) };
    }

    async function upsertLine(args) {
        const id = identifier(args.id, '产线 ID', 64);
        const workshopId = identifier(args.workshopId, '所属车间 ID', 64);
        const name = text(args.name);
        if (!name) throw new Error('产线名称不能为空');
        const db = await getDb();
        if (!await db.get('SELECT id FROM workshops WHERE id = ?', [workshopId])) {
            throw new Error(`车间不存在：${workshopId}`);
        }
        const layout = normalizeLineLayout(args.layout);
        await db.upsert('lines', {
            id,
            name,
            workshop_id: workshopId,
            layout_json: JSON.stringify(layout),
            sort_order: numberOr(args.sortOrder, 0)
        }, 'id');
        return { success: true, line: await db.get('SELECT * FROM `lines` WHERE id = ?', [id]) };
    }

    async function upsertDevice(args) {
        const id = identifier(args.id, '设备 ID', 128);
        const name = text(args.name);
        if (!name) throw new Error('设备名称不能为空');
        const current = await localApi(`/api/devices/${encodeURIComponent(id)}`).catch(() => null);
        const position = args.position && typeof args.position === 'object' ? args.position : {};
        const existing = current || {};
        const body = {
            ...existing,
            id,
            name,
            line_id: args.lineId === undefined ? (existing.line_id || null) : (args.lineId || null),
            model_type: args.modelType || existing.model_type || 'builtin_furnace',
            model_file: args.modelFile ?? existing.model_file ?? null,
            template_id: args.templateId ?? existing.template_id ?? '',
            instance_config: args.instanceConfig ?? existing.instance_config ?? {},
            pos_x: position.x ?? args.pos_x ?? existing.pos_x ?? 0,
            pos_y: position.y ?? args.pos_y ?? existing.pos_y ?? 0,
            pos_z: position.z ?? args.pos_z ?? existing.pos_z ?? 0,
            rotation_y: args.rotationY ?? existing.rotation_y ?? 0,
            scale: args.scale ?? existing.scale ?? 1,
            coordinate_space: args.coordinateSpace || existing.coordinate_space || (args.lineId ? 'line_local' : 'workshop_local'),
            sort_order: args.sortOrder ?? existing.sort_order ?? 0,
            plc_enabled: args.plcEnabled ?? existing.plc_enabled ?? false,
            plc_protocol: args.plcProtocol || existing.plc_protocol || 'S7',
            plc_ip: args.plcIp ?? existing.plc_ip ?? '127.0.0.1',
            plc_port: args.plcPort ?? existing.plc_port ?? 1102,
            plc_rack: args.plcRack ?? existing.plc_rack ?? 0,
            plc_slot: args.plcSlot ?? existing.plc_slot ?? 1,
            plc_timeout: args.plcTimeout ?? existing.plc_timeout ?? 3000,
            plc_retry_interval: args.plcRetryInterval ?? existing.plc_retry_interval ?? 2000,
            plc_max_retries: args.plcMaxRetries ?? existing.plc_max_retries ?? 0,
            plc_options: args.plcOptions ?? existing.plc_options ?? {}
        };
        delete body.dataPoints;
        const saved = current
            ? await localApi(`/api/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
            : await localApi('/api/devices', { method: 'POST', body: JSON.stringify(body) });
        return { success: true, id, created: !current, response: saved };
    }

    async function syncDevicePoints(args) {
        const deviceId = identifier(args.deviceId, '设备 ID', 128);
        if (!Array.isArray(args.points)) throw new Error('points 必须是数组');
        const payload = await localApi('/api/datapoints/sync', {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: args.points })
        });
        return { ...payload, deviceId };
    }

    async function setDataMode(args) {
        const mode = text(args.mode).toLowerCase();
        if (!['simulation', 'integrated_plc'].includes(mode)) throw new Error('mode 只能是 simulation 或 integrated_plc');
        const db = await getDb();
        await db.upsert('settings', { key: 'data_mode', value: mode }, 'key');
        if (args.simulationIntervalMs !== undefined) {
            const interval = Math.max(250, Math.min(60000, Math.round(numberOr(args.simulationIntervalMs, 2000))));
            await db.upsert('settings', { key: 'simulation_interval_ms', value: String(interval) }, 'key');
        }
        if (global.dataEngine?.restart) await global.dataEngine.restart();
        return { success: true, mode, engine: global.dataEngine?.getStatus?.() || null };
    }

    async function saveDashboardDraft(args) {
        const db = await getDb();
        const saved = await saveDraft(db, {
            sceneId: args.sceneId || '',
            document: args.document,
            expectedRevision: args.expectedRevision
        });
        return { success: true, revision: saved.revision, document: saved.document };
    }

    async function publishDashboard(args) {
        const db = await getDb();
        const published = await publishDraft(db, {
            sceneId: args.sceneId || '',
            version: args.version,
            notes: args.notes || 'MCP 现场样板验收发布'
        });
        global.wsServer?.broadcast?.('dashboard_release_changed', {
            releaseId: published.release.id,
            version: published.release.version,
            timestamp: Date.now()
        });
        return { success: true, release: published.release };
    }

    async function configureDemoSite(args = {}) {
        const workshopLayout = {
            version: 2,
            coordinateSpace: 'factory_world',
            transform: { x: 118, y: 0, z: 0, rotationY: 0 },
            size: { width: 100, depth: 82, height: 8 },
            boundary: { enabled: true }
        };
        const lineOneLayout = {
            version: 2,
            coordinateSpace: 'workshop_local',
            placementPending: false,
            transform: { x: 0, y: 0, z: -22, rotationY: 0 },
            flowDirection: 'right',
            lanes: [{ id: 'demo_lane_a', name: '淬火设备线', type: 'device_lane', offsetZ: 0, length: 68, sort_order: 0 }],
            rails: [{ id: 'demo_rail_a', name: '转运导轨', type: 'cart_rail', offsetZ: 12, length: 68, sort_order: 0 }]
        };
        const lineTwoLayout = {
            version: 2,
            coordinateSpace: 'workshop_local',
            placementPending: false,
            transform: { x: 0, y: 0, z: 22, rotationY: 0 },
            flowDirection: 'right',
            lanes: [{ id: 'demo_lane_b', name: '回火清洗线', type: 'device_lane', offsetZ: 0, length: 68, sort_order: 0 }],
            rails: []
        };
        await upsertWorkshop({ id: 'ws_demo_south', name: '南区热处理示范车间', sortOrder: 10, layout: workshopLayout });
        await upsertLine({ id: 'line_demo_quench', name: '1# 淬火线', workshopId: 'ws_demo_south', sortOrder: 0, layout: lineOneLayout });
        await upsertLine({ id: 'line_demo_temper', name: '2# 回火清洗线', workshopId: 'ws_demo_south', sortOrder: 1, layout: lineTwoLayout });

        const furnaceConfig = {
            labelY: 3.6,
            caption: '示范炉',
            laneId: 'demo_lane_a',
            laneName: '淬火设备线',
            laneLineId: 'line_demo_quench',
            dataProfile: 'heat_treatment',
            animationProfile: 'multipurpose_furnace_native_v1',
            scaleMultiplier: 1,
            statusLightY: 3.0
        };
        await upsertDevice({
            id: 'demo_furnace_01', name: '南区 1# 箱式气氛炉', lineId: 'line_demo_quench',
            modelType: 'photo_multipurpose_furnace_v5', instanceConfig: { ...furnaceConfig, caption: '南区 1# 箱式气氛炉' },
            position: { x: -22, y: 0, z: 0 }, rotationY: 0, scale: 2, sortOrder: 0,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });
        await upsertDevice({
            id: 'demo_furnace_02', name: '南区 2# 箱式气氛炉', lineId: 'line_demo_quench',
            modelType: 'photo_multipurpose_furnace_v5', instanceConfig: { ...furnaceConfig, caption: '南区 2# 箱式气氛炉' },
            position: { x: 2, y: 0, z: 0 }, rotationY: 0, scale: 2, sortOrder: 1,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });
        await upsertDevice({
            id: 'demo_washer_01', name: '南区清洗机', lineId: 'line_demo_temper',
            modelType: 'builtin_furnace', instanceConfig: {
                labelY: 2.8, caption: '南区清洗机', laneId: 'demo_lane_b', laneName: '回火清洗线',
                laneLineId: 'line_demo_temper', dataProfile: 'heat_treatment', animationProfile: 'furnace', scaleMultiplier: 0.9
            },
            position: { x: -5, y: 0, z: 0 }, rotationY: 0, scale: 1.4, sortOrder: 0,
            plcEnabled: false, plcIp: '127.0.0.1', plcPort: 1102
        });

        await syncDevicePoints({
            deviceId: 'demo_furnace_01',
            points: [
                { name: 'actual_temp', label: '实际温度', plc_tag: 'DB20.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'setpoint_temp', label: '设定温度', plc_tag: 'DB20.DBW2', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'actual_carbon', label: '实际碳势', plc_tag: 'DB20.DBW4', data_type: 'REAL', category: 'analog', unit: '%', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'front_door_open', label: '前门开到位', plc_tag: 'DB20.DBX8.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'rear_fan_speed', label: '后室风扇转速', plc_tag: 'DB20.DBW10', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'oil_stir_1_speed', label: '油搅拌 1 转速', plc_tag: 'DB20.DBW12', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'bj1', label: '超温报警', plc_tag: 'DB20.DBX14.0', data_type: 'BOOL', category: 'status', point_kind: 'alarm', alarm_text: '超温报警', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });
        await syncDevicePoints({
            deviceId: 'demo_furnace_02',
            points: [
                { name: 'actual_temp', label: '实际温度', plc_tag: 'DB21.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'actual_carbon', label: '实际碳势', plc_tag: 'DB21.DBW4', data_type: 'REAL', category: 'analog', unit: '%', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'front_door_open', label: '前门开到位', plc_tag: 'DB21.DBX8.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' },
                { name: 'rear_fan_speed', label: '后室风扇转速', plc_tag: 'DB21.DBW10', data_type: 'WORD', category: 'motors', unit: 'rpm', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });
        await syncDevicePoints({
            deviceId: 'demo_washer_01',
            points: [
                { name: 'actual_temp', label: '清洗槽温度', plc_tag: 'DB22.DBW0', data_type: 'WORD', category: 'analog', unit: '°C', sample_interval_ms: 1000, access_type: 'READ' },
                { name: 'running', label: '运行状态', plc_tag: 'DB22.DBX4.0', data_type: 'BOOL', category: 'status', sample_interval_ms: 500, access_type: 'READ' }
            ]
        });

        const db = await getDb();
        const designer = await loadDesignerState(db);
        const document = designer.document;
        document.name = '南区热处理示范车间巡检大屏';
        document.scene = {
            ...document.scene,
            name: '南区热处理示范车间巡检大屏',
            theme: { ...document.scene?.theme, title: '南区热处理示范车间 · 设备巡检中心' },
            defaultViewId: 'factory_overview',
            views: (Array.isArray(document.scene?.views) ? document.scene.views : []).map(view => {
                const names = {
                    device_detail: '设备实体视图',
                    device_xray: '外壳透视视图',
                    device_exploded: '内部部件拆解视图',
                    device_part: '关键部件详情视图'
                };
                return { ...view, name: names[view.id] || view.name };
            })
        };
        document.theme = { ...document.theme, title: '南区热处理示范车间 · 设备巡检中心', accentColor: '#42a5f5' };
        document.metadata = { ...parseJson(document.metadata, {}), scenario: 'south-area-heat-treatment-demo', configuredBy: 'mcp-agent' };
        const draft = await saveDraft(db, {
            sceneId: designer.scene?.id,
            document,
            expectedRevision: designer.revision
        });
        let release = null;
        if (args.publish !== false) {
            release = (await publishDraft(db, {
                sceneId: designer.scene?.id,
                notes: 'MCP 自动配置的南区热处理示范车间现场样板'
            })).release;
        }
        await setDataMode({ mode: 'simulation', simulationIntervalMs: args.simulationIntervalMs || 1000 });
        await db.run(`INSERT INTO event_logs (event_type, level, source_id, title, message, value, quality)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            'system', 'info', 'mcp', '南区热处理示范项目已配置',
            '车间、产线、设备、点位和多级设备巡检视角已完成并进入模拟运行',
            release?.version || 'draft', 'good'
        ]);
        return {
            success: true,
            scenario: 'south-area-heat-treatment-demo',
            workshopId: 'ws_demo_south',
            lineIds: ['line_demo_quench', 'line_demo_temper'],
            deviceIds: ['demo_furnace_01', 'demo_furnace_02', 'demo_washer_01'],
            draftRevision: draft.revision,
            release,
            engine: global.dataEngine?.getStatus?.() || null
        };
    }

    async function runAcceptanceChecks() {
        const state = await loadState();
        const views = state.designer.document?.scene?.views || [];
        const checks = [
            { id: 'database', label: '数据库连接', passed: !!state.db.connected, detail: state.db.type },
            { id: 'engine', label: '数据引擎', passed: ['simulation', 'integrated_plc'].includes(state.engine?.mode), detail: state.engine?.mode || '未启动' },
            { id: 'workshop', label: '空间车间', passed: state.workshops.some(item => item.id === 'ws_demo_south'), detail: `${state.workshops.length} 个车间` },
            { id: 'lines', label: '示范产线', passed: ['line_demo_quench', 'line_demo_temper'].every(id => state.lines.some(item => item.id === id)), detail: `${state.lines.length} 条产线` },
            { id: 'devices', label: '示范设备', passed: ['demo_furnace_01', 'demo_furnace_02', 'demo_washer_01'].every(id => state.devices.some(item => item.id === id)), detail: `${state.devices.length} 台设备` },
            { id: 'model', label: '原生 PBR 模型', passed: state.devices.some(item => item.id === 'demo_furnace_01' && item.model_type === 'photo_multipurpose_furnace_v5'), detail: 'photo_multipurpose_furnace_v5' },
            { id: 'points', label: '关键点位', passed: state.dataPoints.filter(item => item.device_id === 'demo_furnace_01').length >= 6, detail: `${state.dataPoints.filter(item => item.device_id === 'demo_furnace_01').length} 个点位` },
            { id: 'views', label: '多级视角链路', passed: ['device_detail', 'device_xray', 'device_exploded', 'device_part'].every(id => views.some(view => view.id === id)), detail: views.map(view => view.id).join(' → ') },
            { id: 'part-panel', label: '部件详情面板', passed: state.designer.document?.widgets?.some(widget => widget.id === 'widget_device_part_panel' || widget.groupId === 'group_device_part_detail'), detail: 'selectedPart 上下文' },
            (() => { const license = getLicenseStatus(); return { id: 'license', label: '离线授权', passed: !license.enforce || license.valid, detail: license.reason }; })(),
            { id: 'release', label: '运行版本', passed: !!state.designer.currentRelease, detail: state.designer.currentRelease?.version || '未发布' }
        ];
        return { success: checks.every(check => check.passed), checks, checkedAt: new Date().toISOString() };
    }

    async function getHeatTreatmentTemplateLibrary(args = {}) {
        const category = text(args.category).toLowerCase();
        const packs = getHeatTreatmentTemplatePacks().filter(pack => !category || pack.category === category);
        return { success: true, readOnly: true, contractVersion: 1, packs, count: packs.length };
    }

    async function configureReadonlyBusinessSource(args = {}) {
        const id = identifier(args.id, '数据源 ID', 80);
        if (id === 'primary') throw new Error('排产业务数据源必须使用独立的只读连接，不能覆盖主配置库');
        if ((args.sourceType && args.sourceType !== 'database') || text(args.type).toLowerCase() === 'http_api') {
            throw new Error('排产业务数据源仅支持数据库连接，HTTP API 目前仅支持健康检查');
        }
        const input = {
            ...args,
            id,
            name: text(args.name),
            type: text(args.type || 'mysql').toLowerCase(),
            enabled: args.enabled !== false,
            readOnly: true
        };
        if (!input.name) throw new Error('数据源名称不能为空');
        const tested = await testDataSource(input);
        if (!tested.success) throw new Error(tested.error || tested.health?.message || '外部数据库连接测试失败，未保存或发布配置');
        const connection = saveDataSource({ ...input, healthToken: tested.healthToken });
        let binding = { changedWidgets: 0, revision: null, release: null };
        if (args.bindBusinessWidgets !== false) {
            const db = await getDb();
            const designer = await loadDesignerState(db);
            let changedWidgets = 0;
            const document = {
                ...designer.document,
                widgets: (designer.document.widgets || []).map(widget => {
                    if (widget?.data?.mode !== 'business') return widget;
                    changedWidgets += 1;
                    return {
                        ...widget,
                        data: {
                            ...widget.data,
                            connectionId: id,
                            datasets: (Array.isArray(widget.data.datasets) ? widget.data.datasets : [])
                                .map(dataset => ({ ...dataset, connectionId: id }))
                        }
                    };
                })
            };
            if (changedWidgets > 0) {
                const draft = await saveDraft(db, {
                    sceneId: designer.scene?.id,
                    document,
                    expectedRevision: designer.revision
                });
                const published = await publishDraft(db, {
                    sceneId: designer.scene?.id,
                    notes: `MCP 绑定外部业务只读数据源：${connection.name}`
                });
                binding = {
                    changedWidgets,
                    revision: draft.revision,
                    release: published.release
                };
                global.wsServer?.broadcast?.('dashboard_release_changed', {
                    releaseId: published.release.id,
                    version: published.release.version,
                    timestamp: Date.now()
                });
            }
        }
        return {
            success: true,
            readOnly: true,
            connection,
            test: { success: tested.success === true },
            binding
        };
    }

    async function installLicense(args = {}) {
        if (!args.license || typeof args.license !== 'object') throw new Error('license 必须是对象');
        return await localApi('/api/license', { method: 'PUT', body: JSON.stringify({ license: args.license }) });
    }

    async function getReleaseStatus() {
        return await localApi('/api/release');
    }

    async function callTool(name, args = {}) {
        switch (name) {
            case 'get_project_state': return result(await loadState());
            case 'get_model_inspection': return result(await getModelInspection(args));
            case 'get_model_inspection_presets': return result(await getModelInspectionPresets(args));
            case 'apply_model_inspection_preset': return result(await applyModelInspectionPreset(args));
            case 'validate_model_inspection': return result(await validateModelInspection(args));
            case 'save_model_inspection': return result(await saveModelInspection(args));
            case 'update_model_inspection': return result(await updateModelInspection(args));
            case 'apply_model_inspection_layout': return result(await applyModelInspectionLayout(args));
            case 'update_model_part_bindings': return result(await updateModelPartBindings(args));
            case 'update_model_metadata': return result(await updateModelMetadata(args));
            case 'set_data_mode': return result(await setDataMode(args));
            case 'upsert_workshop': return result(await upsertWorkshop(args));
            case 'upsert_line': return result(await upsertLine(args));
            case 'upsert_device': return result(await upsertDevice(args));
            case 'sync_device_points': return result(await syncDevicePoints(args));
            case 'save_dashboard_draft': return result(await saveDashboardDraft(args));
            case 'publish_dashboard': return result(await publishDashboard(args));
            case 'configure_demo_site': return result(await configureDemoSite(args));
            case 'run_acceptance_checks': return result(await runAcceptanceChecks());
            case 'get_heat_treatment_template_library': return result(await getHeatTreatmentTemplateLibrary(args));
            case 'configure_readonly_business_source': return result(await configureReadonlyBusinessSource(args));
            case 'get_license_status': return result({ success: true, readOnly: true, ...getLicenseStatus() });
            case 'install_license': return result(await installLicense(args));
            case 'get_release_status': return result(await getReleaseStatus());
            default: throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
        }
    }

    async function handleRpc(request) {
        if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            return rpcError(request?.id ?? null, -32600, '无效的 JSON-RPC 2.0 请求');
        }
        const id = request.id;
        if (request.method.startsWith('notifications/')) return null;
        try {
            switch (request.method) {
                case 'initialize': {
                    const requested = text(request.params?.protocolVersion, '2024-11-05');
                    const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : '2024-11-05';
                    return rpcResult(id, {
                        protocolVersion,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: SERVER_INFO,
                        instructions: '使用 configure_demo_site 创建可重复的现场样板，使用 run_acceptance_checks 验收。'
                    });
                }
                case 'ping':
                    return rpcResult(id, {});
                case 'tools/list':
                    return rpcResult(id, { tools: toolDefinitions() });
                case 'tools/call': {
                    const name = text(request.params?.name);
                    if (!toolDefinitions().some(tool => tool.name === name)) {
                        return rpcError(id, -32602, `未知工具：${name}`);
                    }
                    return rpcResult(id, await callTool(name, request.params?.arguments || {}));
                }
                case 'resources/list':
                    return rpcResult(id, { resources: [] });
                default:
                    return rpcError(id, -32601, `不支持的方法：${request.method}`);
            }
        } catch (error) {
            const code = Number(error.code);
            if (Number.isInteger(code) && code <= -32000) return rpcError(id, code, error.message);
            return rpcResult(id, errorResult(error.message));
        }
    }

    router.get('/', (req, res) => {
        res.json({ success: true, name: SERVER_INFO.name, version: SERVER_INFO.version, transport: 'streamable-http-json-rpc', endpoint: '/api/mcp' });
    });

    router.post('/', async (req, res) => {
        const body = req.body;
        if (Array.isArray(body)) {
            const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
            if (!responses.length) {
                res.status(202).end();
                return;
            }
            res.json(responses);
            return;
        }
        const response = await handleRpc(body);
        if (!response) {
            res.status(202).end();
            return;
        }
        res.json(response);
    });

    return router;
}

module.exports = createMcpRouter;
