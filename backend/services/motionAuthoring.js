'use strict';
// Compile editor recipes to the existing portable Three/Unity format. No script
// evaluation, Unity project edit, Blender installation or customer GLB rewrite.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
let mathLibrary;
const math = () => mathLibrary ||= require('three'); // load only while authoring, not for ordinary collection/config reads
const { canonicalJson } = require('./deviceInspection');
const { renameAtomicSync, isTransientRenameError } = require('../utils/atomicRename');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uploadsRoot = () => path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads'));
function localFile(url) {
    if (typeof url !== 'string' || !/^\/(assets\/models|assets\/motions|uploads\/models|uploads\/projects)\//.test(url)
        || /[\\\0%?#]/.test(url) || url.split('/').some(p => p === '.' || p === '..')) throw fail('模型资产路径无效');
    const upload = url.startsWith('/uploads/'), root = upload ? uploadsRoot() : path.resolve(__dirname, '../assets');
    const file = path.resolve(root, url.replace(/^\/(assets|uploads)\//, ''));
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep) || fs.statSync(file).size > 80 * 1024 * 1024) throw fail('模型资产不在允许目录内或超过 80 MB');
    return file;
}
function glb(bytes) {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw fail('请使用有效的 GLB 2.0 模型');
    const chunks = []; let offset = 12;
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) throw fail('GLB 数据不完整');
        const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
        if (size % 4 || offset + size > bytes.length) throw fail('GLB 数据不完整');
        chunks.push({ type, bytes: bytes.subarray(offset, offset + size) }); offset += size;
    }
    if (chunks[0]?.type !== 0x4e4f534a) throw fail('GLB 缺少节点信息');
    const document = JSON.parse(chunks[0].bytes.toString('utf8'));
    if (!Array.isArray(document.nodes) || document.nodes.length > 20000 || [...(document.buffers || []), ...(document.images || [])].some(v => v.uri && !v.uri.startsWith('data:'))) throw fail('动作模型需使用资源内嵌的 GLB，节点不能超过 20000');
    return { document, chunks };
}
function encodeGlb(document, chunks) {
    const json = Buffer.from(JSON.stringify(document)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
    const parts = [{ type: 0x4e4f534a, bytes: padded }, ...chunks.slice(1)];
    const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + parts.reduce((n, p) => n + 8 + p.bytes.length, 0), 8);
    return Buffer.concat([header, ...parts.flatMap(p => { const h = Buffer.alloc(8); h.writeUInt32LE(p.bytes.length); h.writeUInt32LE(p.type, 4); return [h, p.bytes]; })]);
}
function pose(node) {
    const { Vector3, Quaternion, Matrix4 } = math();
    const p = new Vector3(), q = new Quaternion(), s = new Vector3(1, 1, 1);
    if (node.matrix) new Matrix4().fromArray(node.matrix).decompose(p, q, s);
    else { p.fromArray(node.translation || [0, 0, 0]); q.fromArray(node.rotation || [0, 0, 0, 1]); s.fromArray(node.scale || [1, 1, 1]); }
    return { p: p.toArray(), q: q.toArray(), s: s.toArray(), v: [1] };
}
function prepare(model) {
    const source = fs.readFileSync(localFile(model.file_path)), sourceSha256 = sha(source);
    const builtin = require('./builtinModels').builtinMotionForModel(model) || model.motion_package;
    let rig = source, base;
    if (builtin) {
        rig = fs.readFileSync(localFile(builtin.rigPath));
        const bytes = fs.readFileSync(localFile(builtin.clipPath));
        if (sha(rig) !== builtin.rigSha256 || sha(bytes) !== builtin.clipSha256) throw fail('内置动作包校验失败，请恢复原始资产');
        base = JSON.parse(bytes); if (base.modelId !== model.id || base.sourceSha256 !== sourceSha256) throw fail('内置动作与当前模型不一致');
        // Re-editing an uploaded/migrated package keeps its original CAD clips,
        // but recipes replace (not append to) previously compiled user clips.
        base.clips = base.clips.filter(clip => !clip.id.startsWith('user_'));
    }
    const parsed = glb(rig), names = new Map(), reachable = new Set(), visiting = new Set();
    function visit(index) {
        if (!Number.isInteger(index) || !parsed.document.nodes[index] || visiting.has(index)) throw fail('模型节点层级无效');
        if (reachable.has(index)) return;
        visiting.add(index); reachable.add(index);
        for (const child of parsed.document.nodes[index].children || []) visit(child);
        visiting.delete(index);
    }
    const roots = parsed.document.scenes?.[parsed.document.scene ?? 0]?.nodes;
    if (!Array.isArray(roots) || !roots.length) throw fail('模型没有可显示的主场景');
    roots.forEach(visit);
    for (const index of reachable) { const n = parsed.document.nodes[index]; names.set(n.name, (names.get(n.name) || 0) + 1); }
    const usedNames = new Set([...names].filter(([name, count]) => name && count === 1).map(([name]) => name));
    const nodes = parsed.document.nodes.flatMap((n, index) => {
        if (!reachable.has(index)) return [];
        const original = n.name || `部件 ${index + 1}`;
        if (!base && (!n.name || names.get(n.name) > 1)) { let name = `user_motion_node_${index}`; while (usedNames.has(name)) name += '_'; usedNames.add(name); n.name = name; }
        const rest = base?.nodes.find(row => row.name === n.name) || { name: n.name, ...pose(n) };
        if (['p','q','s','v'].some(key => !Array.isArray(rest[key]) || rest[key].length !== (key === 'q' ? 4 : key === 'v' ? 1 : 3) || rest[key].some(v => !Number.isFinite(v)))) throw fail('模型包含无法采样的节点变换，请检查源模型');
        if (!base && n.mesh != null) (parsed.document.meshes[n.mesh].primitives || []).forEach((primitive, slot) => {
            const material = parsed.document.materials?.[primitive.material];
            rest['c' + slot] = material?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
        });
        return [{ id: String(index), name: n.name, label: original, ...rest }];
    });
    if (!base) { rig = encodeGlb(parsed.document, parsed.chunks); base = { schemaVersion: 1, modelId: model.id, sourceSha256, nodes: nodes.map(({ id, label, ...row }) => row), clips: [] }; }
    if (rig.length > 80 * 1024 * 1024) throw fail('运动模型超过 80 MB，请先优化源模型');
    const metadata = typeof model.metadata === 'string' ? JSON.parse(model.metadata || '{}') : model.metadata || {};
    const revision = sha(canonicalJson({ sourceSha256, baseRig: sha(rig), baseClips: base.clips, metadata }));
    return { sourceSha256, rig, base, nodes, revision, actions: metadata.motionAuthoring?.actions || [] };
}
const finite = (v, limit) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
function validateActions(actions, prepared) {
    if (!Array.isArray(actions) || actions.length > 32) throw fail('每个模型最多配置 32 个自定义动作');
    const ids = new Set();
    return actions.map(action => {
        if (!action || Object.keys(action).some(k => !['id', 'label', 'mode', 'duration', 'cycle', 'tracks'].includes(k)) || !/^user_[a-zA-Z0-9_-]{1,64}$/.test(action.id) || ids.has(action.id)) throw fail('动作标识无效或重复');
        ids.add(action.id);
        if (typeof action.label !== 'string' || !action.label.trim() || action.label.length > 80 || /[\u0000-\u001f]/.test(action.label)
            || !['position', 'running'].includes(action.mode) || !finite(action.duration, 30) || action.duration < .1 || !['forward', 'pingpong'].includes(action.cycle)
            || !Array.isArray(action.tracks) || !action.tracks.length || action.tracks.length > 32) throw fail('请设置动作名称、驱动方式、时长及部件');
        const occupied = new Set();
        const tracks = action.tracks.map(track => {
            if (!track || Object.keys(track).some(k => !['nodeId','operation','axis','from','to','start','end','easing','pivot','fromColor','toColor'].includes(k))
                || !prepared.nodes.some(n => n.id === track.nodeId) || !['translate','rotate','scale','visibility','color'].includes(track.operation)
                || !['x','y','z'].includes(track.axis) || !finite(track.from, 10000) || !finite(track.to, 10000)
                || !finite(track.start, 1) || !finite(track.end, 1) || track.start < 0 || track.end <= track.start || track.end > 1
                || !['linear','smooth'].includes(track.easing) || !Array.isArray(track.pivot) || track.pivot.length !== 3 || track.pivot.some(v => !finite(v, 10000))) throw fail('部件、运动范围或时序无效');
            if (track.operation === 'scale' && (track.from <= 0 || track.to <= 0)) throw fail('缩放比例必须大于 0');
            if (track.operation === 'visibility' && ![track.from, track.to].every(v => [0,1].includes(v))) throw fail('显隐值只能为 0 或 1');
            if (track.operation === 'color' && (![track.fromColor, track.toColor].every(v => /^#[\da-f]{6}$/i.test(v)) || !prepared.nodes.find(n => n.id === track.nodeId)?.c0)) throw fail('该部件不支持颜色变化或颜色值无效');
            const channel = { translate: 'p', rotate: 'q', scale: 's', visibility: 'v', color: 'c' }[track.operation];
            const keys = [track.nodeId + ':' + channel, ...(track.operation === 'rotate' && track.pivot.some(Boolean) ? [track.nodeId + ':p'] : [])];
            for (const key of keys) { if (occupied.has(key)) throw fail('同一动作不能重复控制部件的同一通道，请合并到一行'); occupied.add(key); }
            return { ...track };
        });
        return { ...action, label: action.label.trim(), tracks };
    });
}
function compile(model, prepared, input) {
    const { Vector3, Quaternion, Color } = math();
    const actions = validateActions(input, prepared), clips = JSON.parse(JSON.stringify(prepared.base.clips)); let budget = 0;
    for (const action of actions) {
        const count = Math.ceil(action.duration * 24) + 1, tracks = [];
        for (const row of action.tracks) {
            const node = prepared.nodes.find(n => n.id === row.nodeId), channels = new Map();
            const push = (channel, values) => { if (!channels.has(channel)) channels.set(channel, []); channels.get(channel).push(...values); budget += values.length; if (budget > 1500000) throw fail('动作数据过大，请减少部件或缩短时长'); };
            const axis = new Vector3(row.axis === 'x' ? 1 : 0, row.axis === 'y' ? 1 : 0, row.axis === 'z' ? 1 : 0);
            for (let i = 0; i < count; i++) {
                let progress = i / (count - 1);
                if (action.mode === 'running' && action.cycle === 'pingpong') progress = 1 - Math.abs(2 * progress - 1);
                let t = Math.max(0, Math.min(1, (progress - row.start) / (row.end - row.start))); if (row.easing === 'smooth') t = t * t * (3 - 2 * t);
                const value = row.from + (row.to - row.from) * t;
                if (row.operation === 'translate') push('p', new Vector3().fromArray(node.p).addScaledVector(axis, value).toArray());
                else if (row.operation === 'rotate') {
                    const delta = new Quaternion().setFromAxisAngle(axis, value * Math.PI / 180), base = new Quaternion().fromArray(node.q);
                    push('q', base.clone().multiply(delta).normalize().toArray());
                    if (row.pivot.some(Boolean)) { const pivot = new Vector3().fromArray(row.pivot).multiply(new Vector3().fromArray(node.s)); push('p', new Vector3().fromArray(node.p).add(pivot.clone().sub(pivot.clone().applyQuaternion(delta)).applyQuaternion(base)).toArray()); }
                } else if (row.operation === 'scale') { const scale = [...node.s]; scale['xyz'.indexOf(row.axis)] *= value; push('s', scale); }
                else if (row.operation === 'visibility') push('v', [value > .5 ? 1 : 0]);
                else { const color = new Color(row.fromColor).lerp(new Color(row.toColor), t); for (const key of Object.keys(node).filter(k => /^c\d+$/.test(k))) push(key, [...color.toArray(), node[key][3]]); }
            }
            for (const [channel, values] of channels) tracks.push({ node: node.name, channel, size: values.length / count, values: values.map(v => Math.round(v * 1e7) / 1e7) });
        }
        clips.push({ id: action.id, label: action.label, mode: action.mode, duration: action.duration, count, tracks });
    }
    const data = { ...prepared.base, rigSha256: sha(prepared.rig), clips }, bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > 16 * 1024 * 1024) throw fail('动作包超过 16 MB，请减少动作数量或时长');
    const folder = `models/motions/${sha(String(model.id)).slice(0, 24)}`, rigName = sha(prepared.rig) + '.glb', clipName = sha(bytes) + '.json';
    const bundle = { sourcePath: model.file_path, sourceSha256: prepared.sourceSha256, rigPath: `/uploads/${folder}/${rigName}`, rigSha256: sha(prepared.rig), clipPath: `/uploads/${folder}/${clipName}`, clipSha256: sha(bytes),
        actions: clips.map(({ id, label, mode, duration, tracks }) => ({ id, label, mode, duration, channels: tracks.map(t => t.node + ':' + t.channel) })) };
    return { actions, data, bytes, bundle, folder, rigName, clipName };
}
function storeCompiled(prepared, compiled, previewOnly = false) {
    const directory = path.join(uploadsRoot(), compiled.folder); fs.mkdirSync(directory, { recursive: true });
    for (const [name, bytes] of [[compiled.rigName, prepared.rig], ...(previewOnly ? [] : [[compiled.clipName, compiled.bytes]])]) {
        const file = path.join(directory, name);
        const valid = () => fs.existsSync(file) && fs.statSync(file).size === bytes.length && sha(fs.readFileSync(file)) === sha(bytes);
        if (valid()) continue;
        const temporary = path.join(directory, `${name}.${crypto.randomUUID()}.tmp`);
        let failure;
        try {
            fs.writeFileSync(temporary, bytes, { flag: 'wx' });
            try { renameAtomicSync(temporary, file); }
            catch (error) {
                // A concurrent publisher of the same complete content-addressed
                // blob is idempotent. Unrelated disk/I/O failures are not success,
                // and a failed verification must retain the original rename error.
                let published = false;
                if (isTransientRenameError(error) || error.code === 'EEXIST') {
                    try { published = valid(); } catch { /* Keep the rename failure. */ }
                }
                if (!published) throw error;
            }
        } catch (error) { failure = error; throw error; }
        finally {
            try { fs.rmSync(temporary, { force: true }); }
            catch (error) { if (!failure) throw error; }
        }
    }
}
module.exports = { prepare, compile, storeCompiled, validateActions, localFile, glb, encodeGlb };
