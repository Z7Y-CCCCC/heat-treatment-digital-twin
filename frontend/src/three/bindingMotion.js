export function createMotionPreset(kind) {
    const common = { input_min: 0, input_max: 1, output_min: 0, invert: false };
    if (kind === 'door') return { ...common, name: '炉门升降', source_group: 'doors', action: 'translate', axis: 'y', output_max: 1.5, transition_duration: 3 };
    if (kind === 'valve') return { ...common, name: '阀门开关', source_group: 'gas', action: 'rotate_angle', axis: 'y', output_max: 90, transition_duration: 1 };
    if (kind === 'material') return { ...common, name: '有料显示', source_group: 'status', action: 'visibility', axis: 'y', output_max: 1, transition_duration: 0 };
    throw new Error('未知部件运动类型');
}

export function bindingSampleUsable(data, binding) {
    const key = binding.source_key || binding.value_role || binding.key;
    const groups = [binding.source_group || binding.category, 'analog', 'motors', 'doors', 'gas', 'mechanisms', 'status'].filter(Boolean);
    const group = groups.find(name => Object.hasOwn(data?.[name] || {}, key));
    const good = value => value == null || String(value).toLowerCase() === 'good';
    return !!data && data.status?.online !== false && good(data.status?.quality)
        && good(typeof data.quality === 'string' ? data.quality : data.quality?.overall)
        && good(data.quality?.[group]?.[key]);
}

export function setMotionTarget(state, offset, duration) {
    state.targetOffset = offset;
    if (state.offset == null || !(duration > 0)) state.offset = offset;
    return state.offset;
}

export function advanceMotion(state, binding, delta) {
    if (state.suspended || state.offset == null || !Number.isFinite(delta) || delta <= 0) return state.offset;
    const duration = Math.max(0, Math.min(60, Number(binding.transition_duration) || 0));
    const maximum = Number(binding.output_max ?? (binding.action === 'translate' ? 1 : 90));
    const minimum = Number(binding.output_min ?? 0);
    const step = duration > 0 ? Math.abs(maximum - minimum) / duration * delta : Infinity;
    const distance = state.targetOffset - state.offset;
    state.offset += Math.sign(distance) * Math.min(Math.abs(distance), step);
    return state.offset;
}
