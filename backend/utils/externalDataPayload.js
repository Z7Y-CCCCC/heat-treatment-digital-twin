const { XMLParser, XMLValidator } = require('fast-xml-parser');

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER = /^[a-zA-Z_$][\w$]*$/;

function parseDataPath(path) {
    const source = String(path || '');
    if (!source || source.length > 255) throw new Error('字段路径不能为空且最多 255 个字符');
    const segments = [];
    let position = 0;
    while (position < source.length) {
        let match;
        if (source[position] === '[') {
            match = /^\[(\d{1,3})\]/.exec(source.slice(position));
            if (match) {
                segments.push(Number(match[1]));
                position += match[0].length;
                continue;
            }
            match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(source.slice(position));
            if (!match) throw new Error('字段路径格式不正确');
            let key;
            try { key = JSON.parse(match[1]); } catch { throw new Error('字段路径格式不正确'); }
            if (!key || key.length > 100 || /[\u0000-\u001f\u007f]/.test(key) || FORBIDDEN_KEYS.has(key))
                throw new Error('字段路径包含不允许的键名');
            segments.push(key);
            position += match[0].length;
            continue;
        }
        if (position > 0) {
            if (source[position] !== '.') throw new Error('字段路径格式不正确');
            position += 1;
        }
        match = /^[a-zA-Z_$][\w$]*/.exec(source.slice(position));
        if (!match || FORBIDDEN_KEYS.has(match[0])) throw new Error('字段路径格式不正确');
        segments.push(match[0]);
        position += match[0].length;
    }
    if (!segments.length) throw new Error('字段路径格式不正确');
    return segments;
}

function readDataPath(payload, path) {
    return parseDataPath(path).reduce((value, segment) => value?.[segment], payload);
}

function appendDataPath(path, key) {
    if (typeof key === 'number') return `${path}[${key}]`;
    if (FORBIDDEN_KEYS.has(key)) return '';
    return IDENTIFIER.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
}

function parseCsv(text) {
    const records = [];
    let row = [], field = '', quoted = false, closedQuote = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
            else if (character === '"') { quoted = false; closedQuote = true; }
            else field += character;
            continue;
        }
        if (character === '"') {
            if (field || closedQuote) throw new Error('CSV 引号格式不正确');
            quoted = true;
        } else if (character === ',') {
            row.push(field); field = ''; closedQuote = false;
        } else if (character === '\r' || character === '\n') {
            if (character === '\r' && text[index + 1] === '\n') index += 1;
            row.push(field); field = ''; closedQuote = false;
            if (row.some(value => value !== '')) records.push(row);
            row = [];
        } else {
            if (closedQuote) throw new Error('CSV 引号格式不正确');
            field += character;
        }
        if (records.length > 1001) throw new Error('CSV 行数超过 1000 行上限');
    }
    if (quoted) throw new Error('CSV 引号未闭合');
    if (field || row.length) { row.push(field); records.push(row); }
    if (!records.length) throw new Error('CSV 内容为空');
    const used = new Set();
    const headers = records[0].map((raw, index) => {
        const label = raw.replace(/^\uFEFF/, '').trim() || `第${index + 1}列`;
        let key = label, suffix = 2;
        while (used.has(key) || FORBIDDEN_KEYS.has(key)) key = `${label}_${suffix++}`;
        used.add(key);
        return key;
    });
    if (headers.length > 100) throw new Error('CSV 列数超过 100 列上限');
    const rows = records.slice(1, 1001).map(record => Object.fromEntries(headers.map((header, index) => {
        const raw = record[index] ?? '';
        const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : NaN;
        return [header, Number.isFinite(numeric) ? numeric : raw];
    })));
    return { rows };
}

function parseExternalPayload(text, requestedFormat = 'auto', contentType = '') {
    const format = String(requestedFormat || 'auto').toLowerCase();
    if (!['auto', 'json', 'xml', 'csv'].includes(format)) throw new Error('不支持的接口响应格式');
    const trimmed = text.trimStart();
    const resolved = format !== 'auto' ? format
        : /(?:^|[+/])json\b/i.test(contentType) || /^[{\[]/.test(trimmed) ? 'json'
        : /(?:^|[+/])xml\b/i.test(contentType) || trimmed.startsWith('<') ? 'xml'
        : 'csv';
    if (resolved === 'json') {
        try { return JSON.parse(text); } catch { throw new Error('接口返回的不是有效 JSON'); }
    }
    if (resolved === 'xml') {
        if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('XML 不允许 DTD 或实体声明');
        if (XMLValidator.validate(text) !== true) throw new Error('接口返回的不是有效 XML');
        try {
            return new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: true, processEntities: false }).parse(text);
        } catch { throw new Error('接口返回的不是有效 XML'); }
    }
    return parseCsv(text);
}

module.exports = { parseDataPath, readDataPath, appendDataPath, parseExternalPayload };
