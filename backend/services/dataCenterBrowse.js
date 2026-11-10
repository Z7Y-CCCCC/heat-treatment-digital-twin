'use strict';
// A bounded, read-only view of existing sources. This is neither a collector
// nor a second historical store, and never promotes catalog sample values.
const center = require('./dataCenter');
const { listDataSets, normalizeDataSet, readDefinition } = require('./dataSets');
const { mergeBuiltinModels } = require('./builtinModels');
const { effectiveInspection } = require('./deviceInspection');
const { normalizeRecordTimestamp: timestamp, resolveRecordTimeColumn } = require('./dataRecordTime');
const { getDbStatus } = require('../db/database');
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const DAY = 86400000;
const ALLOWED = new Set(['mode','q','device_id','part_id','field_id','page','page_size','start','end','factory_id']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const parseObject = value => { try { const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
function string(value, label, max = 100) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label}格式不正确或过长`);
    return value.trim();
}
function positive(value, fallback, max, label) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value) || Number(value) > max) throw fail(`${label}超出允许范围`);
    return Number(value);
}
function rangeTime(value, fallback) {
    if (value == null || value === '') return new Date(fallback).toISOString();
    const text = string(value, '查询时间', 40);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !timestamp(text)
        || new Date(`${text.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== text.slice(0, 10)) throw fail('查询时间请使用含时区的有效日期');
    return timestamp(text);
}
function normalizeQuery(input = {}, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !ALLOWED.has(key))) throw fail('数据浏览查询参数不正确');
    const mode = string(input.mode, '浏览方式') || 'current';
    if (!['current','history'].includes(mode)) throw fail('请选择当前数据或历史记录');
    const result = { mode, q: string(input.q, '搜索内容', 120), page: positive(input.page, 1, 5000, '页码'), pageSize: positive(input.page_size, 20, 100, '每页数量') };
    for (const [key, label] of [['device_id','设备'],['part_id','部件'],['field_id','字段']]) {
        result[key] = string(input[key], label, key === 'field_id' ? 100 : 128);
        if (result[key] && key === 'field_id' && !ID.test(result[key])) throw fail(`${label}标识不正确`);
    }
    if (mode === 'history') {
        result.start = rangeTime(input.start, now - DAY); result.end = rangeTime(input.end, now);
        if (Date.parse(result.end) < Date.parse(result.start) || Date.parse(result.end) - Date.parse(result.start) > 90 * DAY) throw fail('历史时间范围请控制在 90 天以内，结束时间不能早于开始时间');
    }
    return result;
}
function objectPath(device, part = null) { return [device.workshopName, device.lineName, device.name || device.id, part?.name || part?.id].filter(Boolean).join(' / '); }
function row(device, field, part = null) {
    const objectId = part ? `${device.id}:${part.id}` : device.id;
    return { id: center.stableId('record', objectId, field.id), objectId, deviceId: device.id, ...(part ? {partId:part.id} : {}),
        objectName: part?.name || part?.id || device.name || device.id, objectPath: objectPath(device, part),
        fieldId: field.id, fieldName: field.label, value: null, unit: field.unit || '', quality: 'unknown', updatedAt: null };
}
function textMatch(record, q, includeValue = false) {
    if (!q) return true;
    const displayedValue = record.value === true ? '是' : record.value === false ? '否' : record.value;
    const aliases = includeValue && record.value != null ? [record.value, displayedValue, record.unit, `${displayedValue}${record.unit || ''}`, `${displayedValue} ${record.unit || ''}`] : [];
    return [record.objectName, record.objectPath, record.fieldName, record.title, record.level, record.sourceId, ...aliases].some(value => String(value ?? '').toLocaleLowerCase().includes(q.toLocaleLowerCase()));
}
function metadataValue(value) { return typeof value === 'string' ? value.slice(0, 2000) : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : null; }
async function partContexts(db, factoryId, devices) {
    const models = mergeBuiltinModels(await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id=?', [factoryId]));
    const result = [];
    for (const device of devices) {
        const model = models.find(model => String(model.id).toLowerCase() === String(device.model_type || '').toLowerCase()) || models.find(model => device.model_file && model.file_path === device.model_file);
        if (!model) continue;
        try {
            const parts = effectiveInspection(parseObject(model.metadata), parseObject(device.instance_config)).inspection.parts || [];
            for (const part of parts.slice(0, 64)) result.push({ device, part });
        } catch { /* Malformed legacy authored data must not create made-up rows. */ }
    }
    return result;
}
function withValue(record, value) { record.value = metadataValue(value); record.quality = record.value === null || record.value === '' ? 'empty' : 'good'; return record; }
async function runtimeFrame(device, fields, factoryId) {
    if (!global.dataEngine?.getPointRuntimeValues) return null;
    let timer;
    try {
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1800); });
        const frame = await Promise.race([Promise.resolve().then(() => global.dataEngine.getPointRuntimeValues(device.id, fields, factoryId)), timeout]);
        if (frame?.deviceStatus?.deviceId && String(frame.deviceStatus.deviceId) !== device.id) return null;
        return frame;
    } catch { return null; }
    finally { clearTimeout(timer); }
}
function liveQuality(live, point, frame) {
    let quality = ['good','bad','stale','unknown','disabled','empty'].includes(live?.quality) ? live.quality : 'unknown';
    const updatedAt = timestamp(live?.lastReadAt);
    if (frame?.deviceStatus?.online === false || frame?.deviceStatus?.quality === 'bad') quality = 'bad';
    else if (frame?.deviceStatus?.quality === 'stale') quality = 'stale';
    if (quality === 'good' && updatedAt && Date.now() - Date.parse(updatedAt) > Math.max(6000, Number(point.sample_interval_ms || 1000) * 3)) quality = 'stale';
    if (quality === 'good' && (!updatedAt || Date.parse(updatedAt) > Date.now() + 5000)) quality = 'unknown';
    return { quality, updatedAt };
}
function paginate(records, query) {
    const total = records.length, page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)));
    return { records: records.slice((page - 1) * query.pageSize, page * query.pageSize), total, page, pageSize: query.pageSize, hasMore: page * query.pageSize < total };
}
function eventTime(value, dialect) {
    // Match the platform event API: SQLite CURRENT_TIMESTAMP is UTC, while
    // other SQL drivers retain their session/local-time representation.
    if (dialect==='sqlite' && typeof value==='string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return timestamp(`${value.replace(' ','T')}Z`);
    return timestamp(value);
}
function eventSqlTime(value, dialect) {
    const date=new Date(value);
    if(dialect==='sqlite')return date.toISOString().slice(0,19).replace('T',' ');
    const pad=value=>String(value).padStart(2,'0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
async function browseTable(factoryId, tableId, input = {}, options = {}) {
    if (typeof tableId !== 'string' || !ID.test(tableId)) throw fail('数据表标识不正确');
    const query = normalizeQuery(input), state = await center.loadCatalogState(factoryId, options.database || null);
    const catalog = await center.buildCatalog(factoryId, '', state, '', { runtimePreview: false });
    const table = catalog.tables.find(table => table.id === tableId);
    if (!table) throw fail('数据表不存在或不属于当前工厂', 404);
    const fields = catalog.items.filter(field => field.tableId === tableId);
    if (query.field_id && !fields.some(field => field.id === query.field_id)) throw fail('字段不存在或不属于当前数据表', 404);
    const selectedFields = query.field_id ? fields.filter(field => field.id === query.field_id) : fields;
    const devices = await center.scopedDevices(state.db, factoryId, query.device_id);
    if (query.part_id && !query.device_id) throw fail('请先选择部件所属设备');
    const result = { success: true, table: { id: table.id, name: table.name, sourceType: table.sourceType, objectScope: table.objectScope },
        fields: fields.map(({ id,label,type,unit }) => ({ id,label,type,unit })), mode: query.mode,
        records: [], total: 0, page: 1, pageSize: query.pageSize, hasMore: false, readAt: new Date().toISOString(), capabilities: { history: false, deviceRequired: false, partRequired: false, searchSupportsValue: table.id !== 'internal_connection' } };
    if (query.part_id && table.objectScope !== 'part') throw fail('这张数据表不使用部件筛选');
    if(table.id==='internal_events') {
        const dialect=getDbStatus().type;
        const where=['factory_id = ?'],params=[factoryId];
        if(query.device_id){where.push('source_id = ?');params.push(query.device_id)}
        if(query.mode==='history'){
            // Use a conservative SQL window for both second-only SQLite values
            // and fractional MySQL values, then apply the exact UTC range below.
            where.push('occurred_at >= ? AND occurred_at < ?');
            params.push(eventSqlTime(Date.parse(query.start),dialect),eventSqlTime(Date.parse(query.end)+1000,dialect));
        }
        const events=await state.db.all(`SELECT id,source_id,title,message,level,occurred_at FROM event_logs WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC,id DESC LIMIT 5000`,params);
        const byDevice=new Map(devices.map(device=>[String(device.id),device]));
        const records=events.map(event=>({id:`event_${event.id}`,objectId:String(event.source_id || factoryId),deviceId:String(event.source_id || ''),sourceId:String(event.source_id || ''),objectName:byDevice.get(String(event.source_id))?.name || String(event.source_id || '') || '工厂事件',objectPath:byDevice.get(String(event.source_id)) ? objectPath(byDevice.get(String(event.source_id))) : ['当前工厂',event.source_id].filter(Boolean).join(' / '),fieldId:'internal_event_records',fieldName:'报警／事件内容',value:String(event.message || event.title || '').slice(0,2000),title:String(event.title || '').slice(0,2000),unit:'',quality:'good',updatedAt:eventTime(event.occurred_at,dialect),level:event.level})).filter(record=>(query.mode!=='history' || record.updatedAt && record.updatedAt>=query.start && record.updatedAt<=query.end) && textMatch(record,query.q,true));
        return {...result,...paginate(records,query),capabilities:{...result.capabilities,history:true},notice:'读取当前工厂已保存的真实报警／事件记录，最多查询最近 5000 条；没有记录时显示为空，不使用示例事件。'};
    }
    if (table.sourceType === 'dataset') {
        // Catalog visibility is deliberately broader than permission to read
        // actual prepared external records. Decide from the resolved source,
        // not its URL/id spelling; authorization errors must never become502.
        if (typeof options.authorizeExternal === 'function') await options.authorizeExternal({ factoryId, table });
        const stored = (await listDataSets(factoryId, state.db)).find(definition => definition.id === table.datasetId);
        if (!stored) throw fail('外部数据表来源已移除', 404);
        const definition = normalizeDataSet(stored), time = resolveRecordTimeColumn(definition.columns), timeColumn = time.column;
        const historyTimeColumn = definition.columns.find(column => column.role === 'time');
        // A known updatedAt field can describe the returned current record; it
        // does not establish a historical store or an authored history mapping.
        result.capabilities.history = !!historyTimeColumn;
        result.capabilities.deviceRequired = table.objectScope !== 'factory';
        result.capabilities.partRequired = table.objectScope === 'part';
        if (query.mode === 'history' && !historyTimeColumn) throw fail('这张数据表没有可查询的时间字段，不能查看历史记录');
        const parts = table.objectScope === 'part' && query.device_id ? await partContexts(state.db, factoryId, devices) : [];
        result.parts = parts.map(({device,part}) => ({ id: part.id, name: part.name || part.id, deviceId: device.id }));
        const part = query.part_id ? parts.find(context => context.part.id === query.part_id) : null;
        if (query.part_id && !part) throw fail('部件不存在或不属于所选设备', 404);
        if (table.enabled === false || table.sourceReady === false) { result.notice = table.sourceError || '数据表或来源已停用，请检查数据中心的接入配置'; return result; }
        if (table.objectScope !== 'factory' && !query.device_id) { result.notice = '这张数据表按对象映射，请先选择设备后查看实际记录。'; return result; }
        if (table.objectScope === 'part' && !part) { result.notice = '这张数据表按部件映射，请选择设备下的具体部件。'; return result; }
        const device = devices[0], objectMapped = table.objectScope !== 'factory';
        const context = { factoryId, ...(objectMapped && query.device_id ? { deviceId: device.id, lineId: device.lineId, workshopId: device.workshopId } : {}), ...(part ? { partId: part.part.id } : {}) };
        const required = new Set([definition.match?.contextKey, ...definition.request.parameters.filter(parameter => parameter.required && parameter.source !== 'literal').map(parameter => parameter.source === 'parameter' ? 'parameter' : parameter.key)].filter(Boolean));
        if ([...required].some(key => key === 'parameter' || !context[key])) { result.notice = '这张数据表还需要场景或大屏参数，请先在接入配置中完善对象映射；本页不会猜测参数。'; return result; }
        let reading;
        try { reading = await readDefinition(definition, context, factoryId); }
        catch { throw fail('外部数据读取失败，请在数据源中检查连接状态、已配置字段和对象映射后重试。', 502); }
        result.readAt = timestamp(reading.fetchedAt) || result.readAt;
        const output = [], timeField = fields.find(field => field.binding.datasetField === timeColumn?.name), nameColumn = definition.columns.find(column => column.role === 'category');
        if (timeField) {
            result.fields = result.fields.map(field => field.id === timeField.id ? { ...field, role: 'time', timeInferred: time.inferred } : field);
            result.timeFieldId = timeField.id;
            result.timeSource = time.inferred ? 'source-update-field' : 'configured-time-field';
        }
        for (const [index, values] of reading.rows.entries()) {
            const updatedAt = timeColumn ? timestamp(values[timeColumn.name]) : null;
            if (query.mode === 'history' && (!updatedAt || updatedAt < query.start || updatedAt > query.end)) continue;
            for (const field of selectedFields) {
                const entry = objectMapped && query.device_id ? row(device, field, part?.part) : { id: '', objectId: `row_${index + 1}`, objectName: String(nameColumn && values[nameColumn.name] != null ? values[nameColumn.name] : `记录 ${index + 1}`).slice(0, 2000), objectPath: table.name, fieldId: field.id, fieldName: field.label, unit: field.unit || '' };
                entry.id = center.stableId('record', table.id, context, index, field.id, updatedAt);
                entry.value = reading.quality === 'good' ? metadataValue(values[field.binding.datasetField]) : null;
                entry.quality = reading.quality || 'unknown'; entry.updatedAt = updatedAt;
                if (field.id === timeField?.id) {
                    entry.valueType = 'datetime';
                    if (reading.quality === 'good') {
                        const rawTime = values[field.binding.datasetField];
                        entry.value = timestamp(rawTime);
                        if (!entry.value) entry.quality = rawTime === null || rawTime === undefined || rawTime === '' ? 'empty' : 'bad';
                    }
                }
                if (textMatch(entry, query.q, true)) output.push(entry);
            }
        }
        Object.assign(result, paginate(output, query));
        result.sourceRecordCount = reading.rows.length; result.sourceLimit = 100; result.countScope = 'returned-records';
        result.notice = `按已配置的只读规则浏览来源返回的记录（最多前 100 条）；页数及数量仅针对本次返回的数据，不代表整个外部数据库。长文本最多显示前 2000 个字符。${historyTimeColumn ? '历史筛选使用来源提供的时间字段，不新增本地历史存储。' : timeField ? '更新时间来自接口提供的记录更新时间；当前未配置历史时间字段，不新增本地历史存储。' : time.ambiguous ? '来源存在多个可能的更新时间字段，请在字段映射中明确指定时间字段；本页不会猜测或用读取时间替代。' : '来源未提供记录时间时，更新时间显示为 —；上方读取时间仅表示本次读取。'}`;
        if (reading.quality === 'bad') result.notice += ' 部分字段缺失或类型不符，本次结果标记为异常，不展示为正常读数。';
        return result;
    }
    if (query.mode === 'history') throw fail('这张数据表没有已接入的历史记录；当前采集点位不会用模拟曲线代替历史。');
    let candidates = [];
    if (table.id === 'internal_devices') {
        const values = device => ({ internal_device_name: device.name, internal_device_id: device.id, internal_device_model: device.model_type,
            internal_device_workshop: device.workshopName, internal_device_line: device.lineName });
        candidates = devices.flatMap(device => selectedFields.map(field => withValue(row(device, field), values(device)[field.id])));
        result.notice = '逐对象读取已有设备资料；所属车间和产线来自实际关联关系，不可在这里改成常量。资料未提供修改时间时显示 —。';
    } else if (table.id === 'internal_parts') {
        const contexts = await partContexts(state.db, factoryId, devices);
        if (query.part_id && !contexts.some(context => context.part.id === query.part_id)) throw fail('部件不存在或不属于所选设备', 404);
        candidates = contexts.filter(context => !query.part_id || context.part.id === query.part_id).flatMap(({ device,part }) => selectedFields.map(field => withValue(row(device, field, part), part[field.id.replace('internal_part_', '')])));
        if(selectedFields.some(field=>/^internal_part_point_\d+$/.test(field.id))){
            await Promise.all(devices.map(async device=>{
                const points=await state.db.all('SELECT * FROM data_points WHERE device_id=? ORDER BY id',[device.id]);
                const readable=points.filter(point=>String(point.access_type || 'READ').toUpperCase()==='READ');
                const frame=await runtimeFrame(device,readable,factoryId),live=new Map((frame?.points || []).filter(point=>String(point.device_id ?? device.id)===device.id).map(point=>[String(point.id),point]));
                for(const record of candidates.filter(record=>record.deviceId===device.id)){
                    const match=/^internal_part_point_(\d+)$/.exec(record.fieldId);if(!match)continue;
                    const part=contexts.find(context=>context.device.id===device.id && context.part.id===record.partId)?.part;
                    const id=(part?.point_ids || part?.pointIds || [])[Number(match[1])],point=readable.find(point=>String(point.id)===String(id)),reading=live.get(String(id));
                    Object.assign(record,liveQuality(reading,point || {},frame));record.value=record.quality==='good'?metadataValue(reading?.value):null;record.unit=point?.unit || '';
                }
            }));
        }
        result.notice = '逐设备列出模型已有部件资料及设备实例覆盖；没有配置的部件不会生成虚构记录。长文本最多显示前 2000 个字符。';
    } else if (table.id === 'internal_connection') {
        candidates = devices.flatMap(device => selectedFields.map(field => row(device, field)));
        result.notice = '连接状态由当前采集帧提供；没有实时采集帧时显示未连接，不沿用配置中的旧值。';
    } else if (table.sourceType === 'plc') {
        candidates = devices.filter(device => device.id === table.deviceId).flatMap(device => selectedFields.map(field => row(device, field)));
        result.notice = '只展示本设备的只读采集点位；异常或过期读数显示 —。当前未配置逐点历史存储，因此不提供历史曲线。';
    }
    if (table.sourceType === 'plc' && candidates.length) {
        const device = devices.find(device => device.id === table.deviceId);
        const points = (await state.db.all('SELECT * FROM data_points WHERE device_id=? ORDER BY id', [device.id])).filter(point => String(point.access_type || 'READ').toUpperCase() === 'READ');
        const frame = await runtimeFrame(device, points, factoryId);
        const byField = new Map(fields.map(field => [field.id, field]));
        const byPoint = new Map(points.map(point => [String(point.id), point]));
        const byLive = new Map((frame?.points || []).filter(point => String(point.device_id ?? device.id) === device.id).map(point => [String(point.id), point]));
        for (const record of candidates) {
            const field = byField.get(record.fieldId), point = byPoint.get(field.binding.pointId), live = byLive.get(field.binding.pointId);
            Object.assign(record, liveQuality(live, point || {}, frame));
            record.value = record.quality === 'good' ? metadataValue(live?.value) : null;
        }
    }
    candidates = candidates.filter(record => textMatch(record, query.q, result.capabilities.searchSupportsValue));
    Object.assign(result, paginate(candidates, query));
    if (table.id === 'internal_connection') {
        const byDevice = new Map(devices.map(device => [device.id,device]));
        const targetIds = [...new Set(result.records.map(record => record.deviceId))];
        let cursor = 0; const deadline = Date.now() + 6000;
        await Promise.all(Array.from({ length: Math.min(4,targetIds.length) }, async () => {
            while (cursor < targetIds.length) {
                const deviceId = targetIds[cursor++], device = byDevice.get(deviceId);
                const points = [];
                const frame = Date.now() < deadline ? await runtimeFrame(device, points, factoryId) : null;
                for (const record of result.records.filter(record => record.deviceId === deviceId)) {
                    Object.assign(record, liveQuality({ quality: frame?.deviceStatus?.quality || 'bad', lastReadAt: frame?.deviceStatus?.lastReadAt || frame?.snapshotTimestamp }, {}, frame));
                    const online = frame?.deviceStatus?.online !== false;
                    record.value = record.quality === 'good' && online ? '数据正常' : record.quality === 'stale' ? '数据已过期' : '数据异常 / 未连接';
                }
            }
        }));
        result.readAt = new Date().toISOString();
    }
    return result;
}
module.exports = { browseTable, normalizeQuery };
