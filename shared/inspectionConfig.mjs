'use strict';

const MAX_PARTS = 64;
const MAX_SHELL_TARGETS = 100;
const MAX_POINT_LINKS = 256;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value, fallback, min = -Infinity, max = Infinity) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function booleanOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function stringOr(value, fallback = '') {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
}

function uniqueStrings(value, limit = MAX_SHELL_TARGETS) {
    const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return [...new Set(source.map(item => stringOr(item)).filter(Boolean))].slice(0, limit);
}

// Node identifiers are opaque GLB names/paths, not human-entered display text.
function uniqueTargets(value, limit = MAX_SHELL_TARGETS) {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(source.filter(item => item != null).map(String).filter(Boolean))].slice(0, limit);
}

function vector3(value, fallback) {
    const source = Array.isArray(value) ? value : fallback;
    return [0, 1, 2].map(index => numberOr(source[index], fallback[index]));
}

function defaultCamera(yaw, pitch, distanceScale) {
    return { yaw, pitch, distance_scale: distanceScale, target_offset: [0, 0, 0] };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createInspectionDefaults() {
    return {
        version: 2,
        enabled: true,
        offset_space: 'model',
        animation_duration: 1.5,
        shell_duration: 1,
        stagger: 0.06,
        playback_speed: 1,
        easing: 'smoothstep',
        labels: { enabled: true, leader_lines: true },
        shell: {
            node_paths: [],
            node_names: [],
            opacity: 0.18,
            wireframe: false,
            transition: 'clip',
            axis: 'y',
            direction: 1
        },
        solid: {
            view_id: '',
            transition_seconds: 0.65,
            camera: defaultCamera(238, 19, 1.12)
        },
        xray: {
            view_id: '',
            transition_seconds: 0.65,
            camera: defaultCamera(238, 19, 1.08)
        },
        exploded: {
            view_id: '',
            transition_seconds: 1.5,
            camera: defaultCamera(238, 22, 1.22)
        },
        parts: []
    };
}

function normalizeCamera(value, fallback) {
    const source = isObject(value) ? value : {};
    return {
        yaw: numberOr(source.yaw, fallback.yaw, -360, 360),
        pitch: numberOr(source.pitch, fallback.pitch, -89, 89),
        distance_scale: numberOr(source.distance_scale ?? source.distanceScale, fallback.distance_scale, 0.05, 20),
        target_offset: vector3(source.target_offset ?? source.targetOffset, fallback.target_offset)
    };
}

function normalizeStage(value, fallback) {
    const source = isObject(value) ? value : {};
    return {
        view_id: stringOr(source.view_id ?? source.viewId),
        transition_seconds: numberOr(source.transition_seconds ?? source.transitionSeconds, fallback.transition_seconds, 0.05, 10),
        camera: normalizeCamera(source.camera, fallback.camera)
    };
}

function normalizeTargetFields(source, maxTargets = MAX_SHELL_TARGETS) {
    const paths = uniqueTargets([source.node_path ?? source.nodePath, ...(Array.isArray(source.node_paths ?? source.nodePaths) ? source.node_paths ?? source.nodePaths : [])], maxTargets);
    const names = uniqueTargets([source.node_name ?? source.nodeName, ...(Array.isArray(source.node_names ?? source.nodeNames) ? source.node_names ?? source.nodeNames : [])], maxTargets);
    return {
        node_path: paths[0] || '',
        node_name: names[0] || '',
        node_paths: paths.slice(1),
        node_names: names.slice(1)
    };
}

function fallbackParts(partBindings) {
    if (!Array.isArray(partBindings)) return [];
    const parts = partBindings.map((binding, index) => {
        const source = isObject(binding) ? binding : {};
        const sourceKey = stringOr(source.source_key ?? source.sourceKey);
        const sourceGroup = stringOr(source.source_group ?? source.sourceGroup);
        return {
            id: stringOr(source.id) || `part_${index + 1}`,
            name: stringOr(source.name) || stringOr(source.node_name ?? source.nodeName) || stringOr(source.node_path ?? source.nodePath) || `部件 ${index + 1}`,
            node_path: String(source.node_path ?? source.nodePath ?? ''),
            node_name: String(source.node_name ?? source.nodeName ?? ''),
            point_ids: uniqueStrings([source.point_id ?? source.pointId, ...(Array.isArray(source.point_ids ?? source.pointIds) ? source.point_ids ?? source.pointIds : [])], MAX_POINT_LINKS),
            point_keys: sourceKey ? [`${sourceGroup || 'analog'}.${sourceKey}`] : []
        };
    });
    const grouped = new Map();
    for (const part of parts) {
        const key = part.node_path ? `path:${part.node_path}` : `name:${part.node_name}`;
        const existing = grouped.get(key);
        if (existing) {
            existing.point_ids = uniqueStrings([...existing.point_ids, ...part.point_ids], MAX_POINT_LINKS);
            existing.point_keys = uniqueStrings([...existing.point_keys, ...part.point_keys], MAX_POINT_LINKS);
        } else grouped.set(key, part);
    }
    return [...grouped.values()];
}

function normalizePart(value, index, defaults) {
    const source = isObject(value) ? value : {};
    const targets = normalizeTargetFields(source);
    const rawCamera = source.camera;
    return {
        id: stringOr(source.id) || `part_${index + 1}`,
        name: stringOr(source.name) || targets.node_path || targets.node_name || `部件 ${index + 1}`,
        group: stringOr(source.group),
        enabled: booleanOr(source.enabled, true),
        ...targets,
        explode_offset: vector3(source.explode_offset ?? source.explodeOffset, [0, 0, 0]),
        explode_rotation: vector3(source.explode_rotation ?? source.explodeRotation, [0, 0, 0]),
        delay: numberOr(source.delay, 0, 0, 10),
        duration: Number(source.duration) > 0 ? numberOr(source.duration, 0, 0.05, 10) : 0,
        label_offset: vector3(source.label_offset ?? source.labelOffset, [0, 0.35, 0]),
        description: stringOr(source.description),
        point_ids: uniqueStrings(source.point_ids ?? source.pointIds, MAX_POINT_LINKS),
        point_keys: uniqueStrings(source.point_keys ?? source.pointKeys, MAX_POINT_LINKS),
        detail_view_id: stringOr(source.detail_view_id ?? source.detailViewId),
        camera: rawCamera === null ? null : isObject(rawCamera) ? normalizeCamera(rawCamera, defaults.exploded.camera) : null
    };
}

function normalizedSource(input) {
    if (!isObject(input)) return {};
    return isObject(input.inspection) ? input.inspection : input;
}

function normalizeInspection(input = {}, partBindings = []) {
    const defaults = createInspectionDefaults();
    const source = normalizedSource(input);
    const authored = Object.keys(source).length > 0;
    const rawParts = Array.isArray(source.parts) ? source.parts : fallbackParts(partBindings);
    const shellTargets = normalizeTargetFields(source.shell || {}, MAX_SHELL_TARGETS);
    const shellSource = isObject(source.shell) ? source.shell : {};
    const offsetSpace = source.offset_space ?? source.offsetSpace;
    const legacyDocument = authored && offsetSpace === undefined && Number(source.version || 0) < 2;
    const labels = isObject(source.labels) ? source.labels : {};
    const shellTransition = stringOr(shellSource.transition, defaults.shell.transition);
    const shellAxis = stringOr(shellSource.axis, defaults.shell.axis);
    const easing = stringOr(source.easing, defaults.easing);

    return {
        version: 2,
        enabled: booleanOr(source.enabled, defaults.enabled),
        offset_space: offsetSpace === 'parent' || (legacyDocument && offsetSpace !== 'model') ? 'parent' : 'model',
        animation_duration: numberOr(source.animation_duration ?? source.animationDuration, defaults.animation_duration, 0.05, 10),
        shell_duration: numberOr(source.shell_duration ?? source.shellDuration, defaults.shell_duration, 0, 5),
        stagger: numberOr(source.stagger, defaults.stagger, 0, 1),
        playback_speed: numberOr(source.playback_speed ?? source.playbackSpeed, defaults.playback_speed, 0.25, 3),
        easing: ['smoothstep', 'cubic', 'linear'].includes(easing) ? easing : defaults.easing,
        labels: {
            enabled: booleanOr(labels.enabled, defaults.labels.enabled),
            leader_lines: booleanOr(labels.leader_lines ?? labels.leaderLines, defaults.labels.leader_lines)
        },
        shell: {
            node_paths: uniqueTargets([shellTargets.node_path, ...shellTargets.node_paths]),
            node_names: uniqueTargets([shellTargets.node_name, ...shellTargets.node_names]),
            opacity: numberOr(shellSource.opacity, defaults.shell.opacity, 0, 1),
            wireframe: booleanOr(shellSource.wireframe, defaults.shell.wireframe),
            transition: ['clip', 'fade', 'hide'].includes(shellTransition) ? shellTransition : defaults.shell.transition,
            axis: ['x', 'y', 'z'].includes(shellAxis) ? shellAxis : defaults.shell.axis,
            direction: Number(shellSource.direction) < 0 ? -1 : 1
        },
        solid: normalizeStage(source.solid, defaults.solid),
        xray: normalizeStage(source.xray, defaults.xray),
        exploded: normalizeStage(source.exploded, defaults.exploded),
        parts: rawParts.slice(0, MAX_PARTS).map((part, index) => normalizePart(part, index, defaults))
    };
}

function targetEntries(part) {
    return {
        paths: uniqueTargets([part.node_path, ...(part.node_paths || [])]),
        names: uniqueTargets([part.node_name, ...(part.node_names || [])])
    };
}

function pathsOverlap(left, right) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateInspection(input = {}, nodes = []) {
    const source = normalizedSource(input);
    const config = normalizeInspection(input);
    const errors = [];
    const warnings = [];
    const rawParts = Array.isArray(source.parts) ? source.parts : [];
    const rawShell = isObject(source.shell) ? source.shell : {};
    const rawShellTargetCount = uniqueTargets([
        rawShell.node_path ?? rawShell.nodePath,
        ...(Array.isArray(rawShell.node_paths ?? rawShell.nodePaths) ? rawShell.node_paths ?? rawShell.nodePaths : [])
    ], Infinity).length + uniqueTargets([
        rawShell.node_name ?? rawShell.nodeName,
        ...(Array.isArray(rawShell.node_names ?? rawShell.nodeNames) ? rawShell.node_names ?? rawShell.nodeNames : [])
    ], Infinity).length;
    if (!isObject(input) || (Object.hasOwn(source, 'parts') && !Array.isArray(source.parts))) errors.push({ code: 'invalid_config', partId: '', message: '拆解配置必须是对象，parts 必须是数组' });
    if (rawParts.length > MAX_PARTS) errors.push({ code: 'too_many_parts', partId: '', message: `最多只能配置 ${MAX_PARTS} 个拆解部件` });
    if (rawShellTargetCount > MAX_SHELL_TARGETS) errors.push({ code: 'too_many_shell_targets', partId: '', message: `外壳最多只能引用 ${MAX_SHELL_TARGETS} 个节点` });

    const partsById = new Map();
    for (const part of config.parts) {
        if (partsById.has(part.id)) {
            errors.push({ code: 'duplicate_part_id', partId: part.id, message: `部件 ID “${part.id}”重复` });
        } else {
            partsById.set(part.id, part);
        }
        const targets = targetEntries(part);
        if (part.enabled !== false && !targets.paths.length && !targets.names.length) {
            errors.push({ code: 'missing_target', partId: part.id, message: `部件“${part.name}”尚未选择模型节点` });
        }
        for (let index = 0; index < targets.paths.length; index += 1) {
            if (targets.paths.slice(0, index).some(previous => pathsOverlap(previous, targets.paths[index]))) {
                warnings.push({ code: 'redundant_part_target', partId: part.id, message: `部件“${part.name}”包含重复或父子节点，运行端会只保留外层节点` });
                break;
            }
        }
    }

    const nodeList = Array.isArray(nodes) ? nodes.filter(isObject) : [];
    const nodesByPath = new Map(nodeList.filter(node => stringOr(node.path)).map(node => [String(node.path), node]));
    const nodesByName = new Map();
    for (const node of nodeList) {
        const name = node.name == null ? '' : String(node.name);
        if (!name) continue;
        const items = nodesByName.get(name) || [];
        items.push(node);
        nodesByName.set(name, items);
    }

    if (nodeList.length) {
        for (const path of config.shell.node_paths) {
            if (!nodesByPath.has(path)) errors.push({ code: 'missing_shell_node', partId: '', message: `外壳引用的节点不存在：${path}` });
        }
        for (const name of config.shell.node_names) {
            if (!nodesByName.has(name)) errors.push({ code: 'missing_shell_node', partId: '', message: `外壳引用的节点不存在：${name}` });
            else if (nodesByName.get(name).length > 1) errors.push({ code: 'ambiguous_node_name', partId: '', message: `外壳节点名称不唯一，请改用完整路径：${name}` });
        }
    }

    const resolvedShellTargets = [];
    if (nodeList.length) {
        for (const path of config.shell.node_paths) {
            const node = nodesByPath.get(path);
            if (node) resolvedShellTargets.push(node);
        }
        for (const name of config.shell.node_names) {
            const matches = nodesByName.get(name) || [];
            if (matches.length === 1) resolvedShellTargets.push(matches[0]);
        }
    }

    const resolvedByPart = new Map();
    for (const part of config.parts) {
        if (part.enabled === false) continue;
        const targets = targetEntries(part);
        const resolved = [];
        if (nodeList.length) {
            for (const path of targets.paths) {
                const node = nodesByPath.get(path);
                if (!node) errors.push({ code: 'missing_node', partId: part.id, message: `部件“${part.name}”引用的节点不存在：${path}` });
                else resolved.push(node);
            }
            for (const name of targets.names) {
                const matches = nodesByName.get(name) || [];
                if (!matches.length) errors.push({ code: 'missing_node', partId: part.id, message: `部件“${part.name}”引用的节点不存在：${name}` });
                else if (matches.length > 1) errors.push({ code: 'ambiguous_node_name', partId: part.id, message: `部件“${part.name}”的节点名称不唯一，请改用完整路径：${name}` });
                else resolved.push(...matches);
            }
        }
        resolvedByPart.set(part.id, [...new Map(resolved.map(node => [String(node.path), node])).values()]);
    }

    const enabledParts = config.parts.filter(part => part.enabled !== false);
    for (const part of enabledParts) {
        const resolvedPartTargets = resolvedByPart.get(part.id) || [];
        const overlapsShell = resolvedPartTargets.some(node => resolvedShellTargets.some(shell => (
            pathsOverlap(String(node.path), String(shell.path))
        )));
        if (overlapsShell) {
            errors.push({
                code: 'shell_part_overlap',
                partId: part.id,
                message: `部件“${part.name}”与外壳节点重复或存在父子包含关系；请把外壳改为只引用实际外壳网格/节点，避免拆解时误隐藏内部组件`
            });
        }
    }
    for (let index = 0; index < enabledParts.length; index += 1) {
        const current = enabledParts[index];
        const currentTargets = targetEntries(current);
        for (const previous of enabledParts.slice(0, index)) {
            const previousTargets = targetEntries(previous);
            const pathConflict = currentTargets.paths.some(path => previousTargets.paths.some(other => pathsOverlap(path, other)));
            const nameConflict = currentTargets.names.some(name => previousTargets.names.includes(name));
            const resolvedConflict = (resolvedByPart.get(current.id) || []).some(node => (
                (resolvedByPart.get(previous.id) || []).some(other => pathsOverlap(String(node.path), String(other.path)))
            ));
            if (pathConflict || nameConflict || resolvedConflict) {
                errors.push({ code: 'overlapping_part_targets', partId: current.id, message: `部件“${current.name}”与“${previous.name}”引用了相同或父子模型节点` });
            }
        }
    }

    if (!nodeList.length && config.parts.some(part => part.enabled !== false && (part.node_path || part.node_name || part.node_paths.length || part.node_names.length))) {
        warnings.push({ code: 'nodes_unavailable', partId: '', message: '模型节点清单尚未读取，暂时无法校验节点是否存在' });
    }

    return { valid: errors.length === 0, errors, warnings, config: clone(config) };
}

export { createInspectionDefaults, normalizeInspection, validateInspection };
export default { createInspectionDefaults, normalizeInspection, validateInspection };
