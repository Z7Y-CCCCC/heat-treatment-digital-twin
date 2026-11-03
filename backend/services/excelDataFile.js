'use strict';
// Read values only: never launch Office, recalculate formulas or follow links.
const unzipper = require('unzipper');
const { XMLParser } = require('fast-xml-parser');
const fail = message => Object.assign(new Error(message), { userSafe: true });
const MAX_EXPANDED = 8 * 1024 * 1024;
function checkRange(range) {
    for (const address of String(range).split(':')) {
        const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
        const col = match && [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
        if (!match || col > 100 || Number(match[2]) > 1001) throw fail('Excel 数据范围应位于 A1:CV1001 内');
    }
}

async function readExcelData(buffer, sheet = '') {
    try {
        const archive = await unzipper.Open.buffer(buffer);
        if (archive.files.length > 128) throw fail('Excel 文件内容过多，请只保留需要的数据工作表');
        const names = new Set(); let expanded = 0;
        // Check actual inflated bytes as well as central-directory declarations.
        // This prevents a small upload or forged ZIP size from expanding unboundedly.
        for (const entry of archive.files) {
            const name = entry.path;
            if (names.has(name) || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(name) || entry.flags & 1)
                throw fail('Excel 压缩结构无效或文件已加密');
            names.add(name);
            if (entry.uncompressedSize > MAX_EXPANDED || expanded + entry.uncompressedSize > MAX_EXPANDED)
                throw fail('Excel 解压内容不能超过 8 MB');
            const chunks = [];
            for await (const chunk of entry.stream()) {
                expanded += chunk.length;
                if (expanded > MAX_EXPANDED) throw fail('Excel 解压内容不能超过 8 MB');
                if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) chunks.push(chunk);
            }
            if (chunks.length) {
                const xml = Buffer.concat(chunks).toString('utf8');
                if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('Excel XML 包含不允许的声明');
                const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
                    isArray: tag => ['row', 'c', 'mergeCell'].includes(tag) }).parse(xml);
                if (parsed.worksheet?.dimension) checkRange(parsed.worksheet.dimension['@_ref']);
                for (const merge of parsed.worksheet?.mergeCells?.mergeCell || []) checkRange(merge['@_ref']);
                const rows = parsed.worksheet?.sheetData?.row || [];
                if (rows.length > 1001) throw fail('每个工作表最多 1000 行数据、100 列');
                for (const row of rows) {
                    if (Number(row['@_r']) > 1001 || (row.c || []).length > 100) throw fail('Excel 数据范围应位于 A1:CV1001 内');
                    for (const cell of row.c || []) checkRange(cell['@_r']);
                }
            }
        }
        if (!names.has('xl/workbook.xml') || !names.has('[Content_Types].xml')) throw fail('文件不是有效的 XLSX 工作簿');
        if ([...names].some(name => /vbaProject\.bin$/i.test(name))) throw fail('不支持包含宏的工作簿，请另存为 XLSX');
        const { default: readExcelFile } = require('read-excel-file/node');
        const workbook = await readExcelFile(buffer, { trim: false });
        const sheets = workbook.map(item => item.sheet);
        if (!sheets.length || sheets.length > 32) throw fail('Excel 工作表数量应为 1–32 个');
        const selected = !sheet || sheet === '/' ? sheets[0] : sheet;
        if (!sheets.includes(selected)) throw fail('工作表不存在，请检查工作表名称');
        const records = workbook.find(item => item.sheet === selected).data;
        if (!records.length) throw fail('所选工作表为空');
        if (records.length > 1001 || records.some(row => row.length > 100)) throw fail('每个工作表最多 1000 行数据、100 列');
        const used = new Set();
        const headers = records[0].map((raw, index) => {
            const label = String(raw ?? '').trim() || `第${index + 1}列`;
            if (label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) throw fail('Excel 列名应为 100 字以内的单行文本');
            let key = label, suffix = 2;
            while (used.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) key = `${label}_${suffix++}`;
            used.add(key); return key;
        });
        const rows = records.slice(1).map(record => Object.fromEntries(headers.map((header, index) => {
            const value = record[index];
            return [header, value instanceof Date ? value.toISOString() : value ?? null];
        })));
        return { sheet: selected, sheets, rows };
    } catch (error) {
        if (error.userSafe) throw error;
        throw fail('无法读取 XLSX：请检查文件是否损坏、加密或含不支持的单元格');
    }
}
module.exports = { readExcelData };
