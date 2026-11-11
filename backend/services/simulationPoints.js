'use strict';
const { evaluateMathExpression } = require('../utils/mathExpression');
const INTEGER_LIMITS = { BYTE:[0,255], WORD:[0,65535], INT:[-32768,32767], DWORD:[0,4294967295], DINT:[-2147483648,2147483647] };
const TYPES = new Set([...Object.keys(INTEGER_LIMITS), 'BOOL', 'REAL', 'LREAL', 'STRING', 'CHAR', 'DT', 'DTZ', 'DTL', 'DTLZ']);
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const readable = point => ['READ', 'READ_WRITE'].includes(String(point.access_type || 'READ').toUpperCase());
const typeOf = point => String(point.data_type || 'REAL').toUpperCase();
const signature = point => JSON.stringify(['device_id','name','value_role','category','data_type','access_type','scale','offset','expression'].map(key => point[key] ?? null));
function pointPath(point) {
  const group = String(point.category || 'analog'), field = String(point.value_role || point.name || '');
  if (!field || unsafe.has(group) || unsafe.has(field) || ['quality','pointMeta','simulationPoints','timestamp','sourceMode','furnace_id','furnace_name'].includes(group)) throw new Error('模拟点位字段无效');
  return { group, field };
}
function manualValue(point, input) {
  const type = typeOf(point);
  if (!readable(point)) throw new Error('只写点位不能作为模拟读取值修改');
  if (!TYPES.has(type)) throw new Error('不支持的模拟点位数据类型');
  if (type === 'BOOL') {
    if (input === true || input === 1 || input === '1' || input === 'true') return true;
    if (input === false || input === 0 || input === '0' || input === 'false') return false;
    throw new Error('BOOL 值只能是 true / false 或 1 / 0');
  }
  if (INTEGER_LIMITS[type] || type === 'REAL' || type === 'LREAL') {
    if (!['number','string'].includes(typeof input) || String(input).trim() === '') throw new Error('请输入有效数字');
    const value = Number(input);
    if (!Number.isFinite(value)) throw new Error('请输入有限数字');
    const transformed = Number(point.scale ?? 1) !== 1 || Number(point.offset ?? 0) !== 0 || String(point.expression || '').trim();
    if (INTEGER_LIMITS[type] && !transformed) {
      const [min,max] = INTEGER_LIMITS[type];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${type} 需要 ${min}～${max} 范围内的整数`);
    }
    if (type === 'REAL' && !Number.isFinite(Math.fround(value))) throw new Error('数值超出 REAL 范围');
    return value;
  }
  if (typeof input !== 'string') throw new Error('请输入文本值');
  if (type === 'CHAR' && [...input].length !== 1) throw new Error('CHAR 需要单个字符');
  if (input.length > 4096) throw new Error('模拟文本不能超过 4096 个字符');
  if (['DT','DTZ','DTL','DTLZ'].includes(type)) {
    if (!input.trim() || !Number.isFinite(Date.parse(input))) throw new Error('请输入有效日期时间，例如 2026-11-11T12:00:00+08:00');
    return new Date(input).toISOString();
  }
  return input;
}
function automaticValue(point, builtin, tick, now) {
  const type = typeOf(point);
  if (!TYPES.has(type)) return null;
  let seed = 0; for (const char of String(point.id || point.name)) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  let raw;
  if (type === 'BOOL') raw = typeof builtin === 'boolean' ? builtin : /alarm|fault|报警|故障/i.test(`${point.name} ${point.label}`) ? false : Math.floor(tick / 5 + seed) % 2 === 0;
  else if (INTEGER_LIMITS[type] || type === 'REAL' || type === 'LREAL') {
    raw = typeof builtin === 'number' && Number.isFinite(builtin) ? builtin : 50 + Math.sin(tick * .15 + seed % 100) * 20;
    if (INTEGER_LIMITS[type]) raw = Math.max(INTEGER_LIMITS[type][0], Math.min(INTEGER_LIMITS[type][1], Math.round(raw)));
    const scale = Number(point.scale ?? 1), offset = Number(point.offset ?? 0);
    raw = raw * (Number.isFinite(scale) ? scale : 1) + (Number.isFinite(offset) ? offset : 0);
    if (String(point.expression || '').trim()) {
      try { raw = Number(evaluateMathExpression(point.expression, raw)); } catch { return null; }
    }
    if (!Number.isFinite(raw) || type === 'REAL' && !Number.isFinite(Math.fround(raw))) return null;
    return Number(raw.toFixed(6));
  } else if (['DT','DTZ','DTL','DTLZ'].includes(type)) raw = new Date(now).toISOString();
  else raw = type === 'CHAR' ? 'S' : `模拟数据 ${Math.floor(tick / 5)}`;
  return raw;
}
module.exports = { readable, signature, pointPath, manualValue, automaticValue };
