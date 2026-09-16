const fs = require('fs');
const path = require('path');

function decodeEmbeddedResource(uri) {
    const comma = uri.indexOf(',');
    const header = uri.slice(0, comma);
    const payload = uri.slice(comma + 1);
    if (/;base64$/i.test(header)) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.replace(/=+$/, '').length % 4 === 1) {
            throw new Error('模型内嵌资源不是有效的 Base64');
        }
        const bytes = Buffer.from(payload, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) {
            throw new Error('模型内嵌资源不是有效的 Base64');
        }
        return bytes;
    }
    const bytes = [];
    for (let index = 0; index < payload.length;) {
        if (payload[index] === '%') {
            const octet = payload.slice(index + 1, index + 3);
            if (!/^[a-f0-9]{2}$/i.test(octet)) throw new Error('模型内嵌资源的百分号编码不合法');
            bytes.push(parseInt(octet, 16));
            index += 3;
        } else {
            const character = String.fromCodePoint(payload.codePointAt(index));
            bytes.push(...Buffer.from(character));
            index += character.length;
        }
    }
    return Buffer.from(bytes);
}

function validateDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.asset?.version !== '2.0') {
        throw new Error('仅支持有效的 glTF 2.0 模型');
    }
    for (const field of ['buffers', 'images']) {
        if (document[field] !== undefined && !Array.isArray(document[field])) throw new Error(`模型 ${field} 格式不正确`);
        for (const resource of document[field] || []) {
            if (!resource || typeof resource !== 'object') throw new Error(`模型 ${field} 格式不正确`);
            if (resource.uri !== undefined && (typeof resource.uri !== 'string' || !/^data:[^,]+,/i.test(resource.uri))) {
                throw new Error('模型引用了外部文件；请导出包含贴图和缓冲区的单文件 GLB，或使用内嵌 data URI 的 GLTF');
            }
            if (field === 'buffers' && (!Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0)) {
                throw new Error('模型缓冲区长度不合法');
            }
            if (resource.uri) {
                const bytes = decodeEmbeddedResource(resource.uri);
                if (field === 'buffers' && bytes.length < resource.byteLength) throw new Error('内嵌缓冲区内容小于声明长度');
            }
        }
    }
    return document;
}

function parseDocument(bytes) {
    try { return validateDocument(JSON.parse(bytes.toString('utf8'))); }
    catch (error) {
        if (error instanceof SyntaxError) throw new Error('模型 JSON 内容不合法');
        throw error;
    }
}

function validateUploadedModelFile(file) {
    const extension = path.extname(file?.filename || '').toLowerCase();
    if (extension === '.gltf') {
        const document = parseDocument(fs.readFileSync(file.path));
        if ((document.buffers || []).some(buffer => !buffer.uri)) throw new Error('GLTF 缺少内嵌缓冲区，请使用单文件 GLB');
        return;
    }
    if (extension !== '.glb') throw new Error('模型文件扩展名不合法');

    const handle = fs.openSync(file.path, 'r');
    try {
        const size = fs.fstatSync(handle).size;
        const header = Buffer.alloc(12);
        if (size < 20 || fs.readSync(handle, header, 0, 12, 0) !== 12
            || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2
            || header.readUInt32LE(8) !== size || size !== file.size) throw new Error('GLB 文件头或长度校验失败');
        let offset = 12;
        let document;
        let binaryLength;
        let chunkIndex = 0;
        while (offset < size) {
            const chunkHeader = Buffer.alloc(8);
            if (size - offset < 8 || fs.readSync(handle, chunkHeader, 0, 8, offset) !== 8) throw new Error('GLB 分块头不完整');
            const length = chunkHeader.readUInt32LE(0);
            const type = chunkHeader.readUInt32LE(4);
            if (length % 4 || length > size - offset - 8) throw new Error('GLB 分块长度不合法');
            if (chunkIndex === 0 && type !== 0x4e4f534a) throw new Error('GLB 缺少首个 JSON 分块');
            if (type === 0x4e4f534a) {
                if (chunkIndex !== 0 || length === 0) throw new Error('GLB JSON 分块不合法');
                const bytes = Buffer.alloc(length);
                if (fs.readSync(handle, bytes, 0, length, offset + 8) !== length) throw new Error('GLB JSON 分块不完整');
                document = parseDocument(bytes);
            } else if (type === 0x004e4942) {
                if (chunkIndex !== 1 || binaryLength !== undefined) throw new Error('GLB 二进制分块顺序不正确');
                binaryLength = length;
            }
            offset += 8 + length;
            chunkIndex += 1;
        }
        if (!document) throw new Error('GLB 缺少 JSON 内容');
        (document.buffers || []).forEach((buffer, index) => {
            if (buffer.uri) return;
            if (index !== 0 || binaryLength === undefined || buffer.byteLength > binaryLength || binaryLength - buffer.byteLength > 3) {
                throw new Error('GLB 缓冲区声明与二进制内容不一致');
            }
        });
    } finally {
        fs.closeSync(handle);
    }
}

function modelScale(value, fallback = 1) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (value === null || typeof value === 'boolean' || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('模型缩放必须为大于 0 的有限数值');
    }
    return parsed;
}

module.exports = { validateUploadedModelFile, modelScale };
