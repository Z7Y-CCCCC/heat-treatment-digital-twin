const { createHash } = require('node:crypto');
const { normalizeLineLayout, normalizeWorkshopLayout } = require('../utils/spatialLayout');
const { normalizeGround, validateGround } = require('../../shared/industrialGround.mjs');
const { saveLineLayout } = require('./lineLayoutSave');
const { applyTransform, validateTransform, deviceBelongsToFactory } = require('./deviceTransforms');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const revision = layout => createHash('sha256').update(JSON.stringify(normalizeGround(layout.ground))).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// One existing DB transaction owns all three editors' commits. Preflight every
// baseline before writing; no PLC/model/action/port fields are accepted.
async function saveWorkshopArrangement(tx, factoryId, body) {
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !['lines', 'placements', 'devices', 'grounds'].includes(k))) fail('编排保存格式无效');
  const sections = ['lines', 'placements', 'devices', 'grounds'];
  for (const key of sections) {
    if (!Array.isArray(body[key]) || body[key].length > 1000 || new Set(body[key].map(r => r?.id)).size !== body[key].length
      || body[key].some(r => !r || typeof r.id !== 'string' || !r.id)) fail('编排批次格式无效');
  }
  if (!sections.some(k => body[k].length)) fail('没有需要保存的编排修改');
  if (body.lines.some(l => body.placements.some(p => p.id === l.id))) fail('产线不能重复提交结构和位置');
  await tx.run('UPDATE factories SET id=id WHERE id=?', [factoryId]);
  const loadedLines = new Map(), loadedGrounds = new Map();
  for (const item of [...body.lines, ...body.placements]) {
    if (Object.keys(item).some(k => !['id', 'expectedLayout', 'expectedRecord', 'value'].includes(k)) || !item.expectedLayout || !item.value) fail('产线编排缺少来源版本');
    const row = await tx.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [item.id, factoryId]);
    if (!row) fail('产线不存在或不属于当前工厂', 404);
    if (!same(normalizeLineLayout(row.layout_json), normalizeLineLayout(item.expectedLayout))) fail('产线已被其他窗口修改，编排草稿保留', 409);
    if (body.lines.includes(item) && (!item.expectedRecord || !same({ name: row.name, workshop_id: row.workshop_id, sort_order: Number(row.sort_order || 0) }, { ...item.expectedRecord, sort_order: Number(item.expectedRecord.sort_order || 0) }))) fail('产线资料已被其他窗口修改，编排草稿保留', 409);
    loadedLines.set(item.id, row);
  }
  for (const item of body.lines) {
    if (Object.keys(item.value).some(k => !['layout', 'name', 'workshop_id', 'sort_order'].includes(k))) fail('产线结构包含不可修改字段');
  }
  for (const item of body.placements) {
    if (Object.keys(item.value).some(k => !['transform', 'placementPending'].includes(k)) || typeof item.value.placementPending !== 'boolean'
      || !item.value.transform || Object.keys(item.value.transform).some(k => !['x', 'y', 'z', 'rotationY'].includes(k))
      || ['x', 'y', 'z', 'rotationY'].some(k => !Number.isFinite(item.value.transform[k]) || Math.abs(item.value.transform[k]) > 100000)) fail('产线位置无效');
  }
  for (const item of body.devices) {
    if (Object.keys(item).some(k => !['id', 'expected', 'value'].includes(k)) || !item.expected || !item.value) fail('设备编排缺少来源版本');
    validateTransform(item.value);
    const row = await tx.get('SELECT * FROM devices WHERE id=?', [item.id]);
    if (!await deviceBelongsToFactory(tx, row, factoryId)) fail('设备不存在或不属于当前工厂', 404);
    const allowed = ['id', 'model_type', 'model_file', 'line_id', 'pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale', 'sort_order', 'coordinate_space', 'instance_config'];
    if (!allowed.every(k => Object.hasOwn(item.expected, k)) || Object.keys(item.expected).some(k => !allowed.includes(k))) fail('设备来源快照无效');
    for (const [key, value] of Object.entries(item.expected)) {
      const current = key === 'instance_config' ? parse(row[key] || '{}') : typeof value === 'number' ? Number(row[key] ?? (key === 'scale' ? 1 : 0)) : row[key] ?? '';
      if (!same(current, value)) fail('设备已被其他窗口修改，编排草稿保留', 409);
    }
  }
  for (const item of body.grounds) {
    if (Object.keys(item).some(k => !['id', 'ground', 'expectedRevision'].includes(k)) || !/^[a-f0-9]{64}$/.test(item.expectedRevision || '')) fail('地面来源版本无效');
    const row = await tx.get('SELECT * FROM workshops WHERE id=? AND factory_id=?', [item.id, factoryId]);
    if (!row) fail('车间不存在', 404);
    const layout = normalizeWorkshopLayout(row.layout_json);
    if (revision(layout) !== item.expectedRevision) fail('地面已被其他窗口修改，编排草稿保留', 409);
    loadedGrounds.set(item.id, { layout, ground: validateGround(item.ground) });
  }
  for (const item of body.lines) await saveLineLayout(tx, item.id, factoryId, { ...item.value, expectedLayout: item.expectedLayout });
  for (const item of body.placements) {
    const layout = normalizeLineLayout({ ...normalizeLineLayout(loadedLines.get(item.id).layout_json), ...item.value });
    await tx.run('UPDATE `lines` SET layout_json=? WHERE id=?', [JSON.stringify(layout), item.id]);
  }
  for (const item of body.devices) await applyTransform(tx, item.id, item.value, factoryId);
  const grounds = [];
  for (const [id, value] of loadedGrounds) {
    const layout = { ...value.layout, ground: value.ground };
    await tx.run('UPDATE workshops SET layout_json=? WHERE id=? AND factory_id=?', [JSON.stringify(layout), id, factoryId]);
    grounds.push({ id, ground: value.ground, revision: revision(layout) });
  }
  return { success: true, lines: body.lines.length + body.placements.length, devices: body.devices.length, grounds };
}
module.exports = { saveWorkshopArrangement };
