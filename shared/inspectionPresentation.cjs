// Model display settings only. Structure, PLC links, coordinates and asset
// identity are deliberately excluded from this partial-write contract.
const FIELDS = Object.freeze(['animation_duration', 'shell_duration', 'stagger', 'playback_speed', 'easing', 'labels', 'shell', 'solid', 'xray', 'exploded']);
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function presentationChanges(next, before) {
    return Object.fromEntries(FIELDS.filter(key => !same(next?.[key], before?.[key]) && next?.[key] !== undefined)
        .map(key => [key, copy(next[key])]));
}
function assertPresentationPatch(patch) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const keys = (value, allowed) => {
        if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('显示设置包含无效字段');
    };
    keys(patch, FIELDS);
    const number = (value, min, max) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('显示设置数值超出范围'); };
    const boolean = value => { if (typeof value !== 'boolean') throw new Error('显示开关必须为布尔值'); };
    const member = (value, values) => { if (!values.includes(value)) throw new Error('显示设置选项无效'); };
    for (const [key, min, max] of [['animation_duration',.05,10],['shell_duration',0,5],['stagger',0,1],['playback_speed',.25,3]])
        if (Object.hasOwn(patch,key)) number(patch[key],min,max);
    if (Object.hasOwn(patch,'easing')) member(patch.easing,['smoothstep','cubic','linear']);
    if (Object.hasOwn(patch, 'labels')) keys(patch.labels, ['enabled', 'leader_lines']);
    if (Object.hasOwn(patch, 'shell')) keys(patch.shell, ['node_path', 'node_paths', 'node_name', 'node_names', 'opacity', 'wireframe', 'transition', 'axis', 'direction']);
    if (patch.labels) for (const value of Object.values(patch.labels)) boolean(value);
    if (patch.shell) {
        const shell=patch.shell;
        if (Object.hasOwn(shell,'opacity')) number(shell.opacity,0,1);
        if (Object.hasOwn(shell,'wireframe')) boolean(shell.wireframe);
        if (Object.hasOwn(shell,'transition')) member(shell.transition,['clip','fade','hide']);
        if (Object.hasOwn(shell,'axis')) member(shell.axis,['x','y','z']);
        if (Object.hasOwn(shell,'direction')) member(shell.direction,[-1,1]);
        for (const key of ['node_paths','node_names']) if (Object.hasOwn(shell,key) && (!Array.isArray(shell[key]) || shell[key].length>100 || shell[key].some(value=>typeof value!=='string'||!value.trim()||value.length>2048))) throw new Error('外壳节点引用无效');
        for (const key of ['node_path','node_name']) if (Object.hasOwn(shell,key) && typeof shell[key]!=='string') throw new Error('外壳节点引用无效');
    }
    for (const stage of ['solid', 'xray', 'exploded']) if (Object.hasOwn(patch, stage)) {
        keys(patch[stage], ['view_id', 'transition_seconds', 'camera']);
        if (Object.hasOwn(patch[stage], 'camera')) keys(patch[stage].camera, ['yaw', 'pitch', 'distance_scale', 'target_offset']);
        const value=patch[stage];
        if (Object.hasOwn(value,'transition_seconds')) number(value.transition_seconds,.05,10);
        if (Object.hasOwn(value,'view_id') && (typeof value.view_id!=='string'||value.view_id.length>128)) throw new Error('视角 ID 无效');
        if(value.camera){
            for(const [key,min,max] of [['yaw',-360,360],['pitch',-89,89],['distance_scale',.05,20]]) if(Object.hasOwn(value.camera,key))number(value.camera[key],min,max);
            if(Object.hasOwn(value.camera,'target_offset')&&(!Array.isArray(value.camera.target_offset)||value.camera.target_offset.length!==3||value.camera.target_offset.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>100000)))throw new Error('镜头中心偏移无效');
        }
    }
    return patch;
}
function mergePresentationSettings(base, patch) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    return Object.fromEntries([...new Set([...Object.keys(object(base) ? base : {}), ...Object.keys(patch)])].map(key => {
        const value = patch[key];
        return [key, object(value) ? mergePresentationSettings(base?.[key], value)
            : Object.hasOwn(patch,key) ? copy(value) : base[key]];
    }));
}
module.exports = { INSPECTION_PRESENTATION_FIELDS: FIELDS, presentationChanges, assertPresentationPatch, mergePresentationSettings };
