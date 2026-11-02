const crypto = require('node:crypto');
const PREFIX = 'HTA1';
const MAX_CODE_LENGTH = 16384;
function encodeActivationCode(document) {
    const body = Buffer.from(JSON.stringify(document)).toString('base64url');
    const checksum = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    const code = `${PREFIX}.${body}.${checksum}`;
    if (code.length > MAX_CODE_LENGTH) throw new Error('授权内容过长，无法生成可用激活码');
    return code;
}
function decodeActivationCode(input) {
    const text = String(input || '').trim();
    if (!text || text.length > MAX_CODE_LENGTH) throw new Error('请粘贴完整激活码');
    if (text.startsWith('{')) return JSON.parse(text); // Existing signed license files remain usable.
    const compact = text.replace(/\s/g, '');
    const match = /^HTA1\.([A-Za-z0-9_-]+)\.([a-f0-9]{12})$/.exec(compact);
    if (!match || crypto.createHash('sha256').update(match[1]).digest('hex').slice(0, 12) !== match[2])
        throw new Error('激活码不完整或有误，请重新复制');
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw new Error('激活码格式无效');
    return JSON.parse(bytes.toString('utf8'));
}
module.exports = { encodeActivationCode, decodeActivationCode, MAX_CODE_LENGTH };
