const crypto = require('crypto');

const MASKED_SECRET = '******';

const PROTOCOL_DEFINITIONS = Object.freeze({
    S7: Object.freeze({
        value: 'S7',
        label: '西门子 S7',
        shortLabel: 'S7',
        defaultPort: 102,
        addressPlaceholder: 'DB1.DBW0 / DB1.DBX6.0',
        addressHint: '支持 DB、I、Q、M 地址，例如 DB1.DBW0、DB1.DBD4、DB1.DBX6.0。'
    }),
    MODBUS_TCP: Object.freeze({
        value: 'MODBUS_TCP',
        label: 'Modbus TCP',
        shortLabel: 'Modbus TCP',
        defaultPort: 502,
        addressPlaceholder: 'HR40001 / IR30001 / C00001',
        addressHint: 'HR=保持寄存器，IR=输入寄存器，C=线圈，DI=离散输入；例如 HR40001、HR40003.2、IR30001。'
    }),
    OPC_UA: Object.freeze({
        value: 'OPC_UA',
        label: 'OPC UA',
        shortLabel: 'OPC UA',
        defaultPort: 4840,
        addressPlaceholder: 'ns=2;s=Channel1.Device1.Tag1',
        addressHint: '填写 OPC UA NodeId，例如 ns=2;s=Channel1.Device1.Tag1 或 ns=3;i=1001。'
    })
});

const PROTOCOL_ALIASES = new Map([
    ['S7', 'S7'],
    ['SIEMENS', 'S7'],
    ['SIEMENS_S7', 'S7'],
    ['MODBUS', 'MODBUS_TCP'],
    ['MODBUS_TCP', 'MODBUS_TCP'],
    ['MODBUS-TCP', 'MODBUS_TCP'],
    ['MODBUSTCP', 'MODBUS_TCP'],
    ['OPC_UA', 'OPC_UA'],
    ['OPC-UA', 'OPC_UA'],
    ['OPCUA', 'OPC_UA']
]);

const OPC_SECURITY_MODES = new Set(['None', 'Sign', 'SignAndEncrypt']);
const OPC_SECURITY_POLICIES = new Set([
    'None',
    'Basic256Sha256',
    'Aes128_Sha256_RsaOaep',
    'Aes256_Sha256_RsaPss'
]);

function safeObject(value) {
    if (!value) return {};
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function boundedInteger(value, minimum, maximum, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

function limitedString(value, maximumLength = 255) {
    return String(value ?? '').trim().slice(0, maximumLength);
}

function normalizeProtocol(value) {
    const normalized = String(value || 'S7').trim().toUpperCase().replace(/\s+/g, '_');
    return PROTOCOL_ALIASES.get(normalized) || normalized;
}

function getProtocolDefinition(value) {
    return PROTOCOL_DEFINITIONS[normalizeProtocol(value)] || null;
}

function defaultPortForProtocol(value) {
    return getProtocolDefinition(value)?.defaultPort || 102;
}

function normalizePlcOptions(protocolValue, value, existingValue = {}) {
    const protocol = normalizeProtocol(protocolValue);
    const source = safeObject(value);
    const existing = safeObject(existingValue);

    if (protocol === 'MODBUS_TCP') {
        return {
            unitId: boundedInteger(source.unitId, 1, 247, boundedInteger(existing.unitId, 1, 247, 1)),
            addressBase: boundedInteger(source.addressBase, 0, 1, boundedInteger(existing.addressBase, 0, 1, 1)),
            byteOrder: String(source.byteOrder || existing.byteOrder || 'BE').toUpperCase() === 'LE' ? 'LE' : 'BE',
            wordOrder: String(source.wordOrder || existing.wordOrder || 'BE').toUpperCase() === 'LE' ? 'LE' : 'BE',
            stringLength: boundedInteger(source.stringLength, 1, 240, boundedInteger(existing.stringLength, 1, 240, 16))
        };
    }

    if (protocol === 'OPC_UA') {
        const requestedMode = limitedString(source.securityMode || existing.securityMode || 'None', 32);
        const securityMode = OPC_SECURITY_MODES.has(requestedMode) ? requestedMode : 'None';
        const requestedPolicy = limitedString(source.securityPolicy || existing.securityPolicy || 'None', 64);
        const securityPolicy = securityMode === 'None'
            ? 'None'
            : (OPC_SECURITY_POLICIES.has(requestedPolicy) && requestedPolicy !== 'None'
                ? requestedPolicy
                : 'Basic256Sha256');
        const requestedPassword = source.password;
        const password = requestedPassword === undefined || requestedPassword === MASKED_SECRET
            ? String(existing.password ?? '').slice(0, 512)
            : String(requestedPassword ?? '').slice(0, 512);
        let endpointPath = limitedString(
            source.endpointPath === undefined ? existing.endpointPath : source.endpointPath,
            512
        );
        if (endpointPath && !endpointPath.startsWith('/')) endpointPath = `/${endpointPath}`;

        return {
            endpointPath,
            securityMode,
            securityPolicy,
            username: limitedString(source.username ?? existing.username, 128),
            password,
            trustServerCertificate: booleanValue(
                source.trustServerCertificate,
                booleanValue(existing.trustServerCertificate, false)
            )
        };
    }

    return {};
}

function sanitizePlcOptions(protocolValue, value, { maskSecrets = true } = {}) {
    const protocol = normalizeProtocol(protocolValue);
    const options = normalizePlcOptions(protocol, value);
    if (protocol === 'OPC_UA' && maskSecrets && options.password) {
        return { ...options, password: MASKED_SECRET };
    }
    return options;
}

function canonicalDataType(dataType) {
    const type = String(dataType || 'WORD').trim().toUpperCase();
    if (type === 'BOOL' || type === 'BIT' || type === 'X') return 'BOOL';
    if (type === 'FLOAT' || type === 'REAL' || type === 'R') return 'REAL';
    if (type === 'LREAL' || type === 'LR') return 'LREAL';
    if (type === 'DINT' || type === 'DI') return 'DINT';
    if (type === 'DWORD' || type === 'DW') return 'DWORD';
    if (type === 'INT' || type === 'I') return 'INT';
    if (type === 'BYTE' || type === 'B') return 'BYTE';
    if (type === 'STRING' || type === 'S') return 'STRING';
    if (type === 'CHAR' || type === 'C') return 'CHAR';
    if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(type)) return type;
    return 'WORD';
}

function typeFromS7Token(token, dataType) {
    const normalized = String(token || '').toUpperCase();
    const pointType = canonicalDataType(dataType);
    if (normalized === 'X') return 'BOOL';
    if (normalized === 'B' || normalized === 'BYTE') return 'BYTE';
    if (normalized === 'W' || normalized === 'WORD') return pointType === 'INT' ? 'INT' : 'WORD';
    if (normalized === 'I' || normalized === 'INT') return 'INT';
    if (normalized === 'DI' || normalized === 'DINT') return 'DINT';
    if (normalized === 'DW' || normalized === 'DWORD') return pointType === 'REAL' ? 'REAL' : 'DWORD';
    if (normalized === 'D') return ['REAL', 'DINT', 'DWORD'].includes(pointType) ? pointType : 'DWORD';
    if (normalized === 'R' || normalized === 'REAL') return 'REAL';
    if (normalized === 'LR' || normalized === 'LREAL') return 'LREAL';
    if (normalized === 'S' || normalized === 'STRING') return 'STRING';
    if (normalized === 'C' || normalized === 'CHAR') return 'CHAR';
    if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(normalized)) return normalized;
    return pointType;
}

function composeS7DbAddress(dbNumber, byteOffset, bitOffset, dataType) {
    if (!Number.isInteger(dbNumber) || dbNumber < 0 || !Number.isInteger(byteOffset) || byteOffset < 0) return null;
    const type = canonicalDataType(dataType);
    if (type === 'STRING' || type === 'CHAR') return null;
    if (type === 'BOOL') {
        const bit = boundedInteger(bitOffset, 0, 7, 0);
        return `DB${dbNumber},X${byteOffset}.${bit}`;
    }
    return `DB${dbNumber},${type}${byteOffset}`;
}

function normalizeS7Address(address, dataType) {
    const compact = String(address || '').replace(/\s+/g, '').toUpperCase();
    if (!compact) return null;
    if (compact.includes(',')) return compact;

    const dbMatch = compact.match(/^DB(\d+)\.DB([A-Z]+)(\d+)(?:\.(\d+))?$/);
    if (dbMatch) {
        const [, db, token, byteOffset, bitOffset] = dbMatch;
        return composeS7DbAddress(
            Number(db),
            Number(byteOffset),
            bitOffset === undefined ? 0 : Number(bitOffset),
            typeFromS7Token(token, dataType)
        );
    }

    return compact;
}

function parseModbusAddress(address, dataType, optionsValue = {}) {
    const options = normalizePlcOptions('MODBUS_TCP', optionsValue);
    let compact = String(address || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!compact) throw new Error('Modbus 地址不能为空');

    let stringLength = options.stringLength;
    const lengthMatch = compact.match(/^(.*)\[(\d+)\]$/);
    if (lengthMatch) {
        compact = lengthMatch[1];
        stringLength = boundedInteger(lengthMatch[2], 1, 240, options.stringLength);
    }

    let bit = null;
    const bitMatch = compact.match(/^(.*)\.(\d{1,2})$/);
    if (bitMatch) {
        compact = bitMatch[1];
        bit = Number(bitMatch[2]);
        if (!Number.isInteger(bit) || bit < 0 || bit > 15) throw new Error('Modbus 寄存器位号必须在 0-15 之间');
    }

    const tokenMatch = compact.match(/^(HR|HOLDING|4X|IR|INPUT|3X|DI|DISCRETE|1X|C|COIL|0X)[:@]?(\d+)$/);
    let area;
    let addressNumber;
    if (tokenMatch) {
        const token = tokenMatch[1];
        const reference = Number(tokenMatch[2]);
        if (['HR', 'HOLDING', '4X'].includes(token)) area = 'holding';
        else if (['IR', 'INPUT', '3X'].includes(token)) area = 'input';
        else if (['DI', 'DISCRETE', '1X'].includes(token)) area = 'discrete';
        else area = 'coil';

        const standardBase = area === 'holding' && reference >= 40001
            ? 40001
            : area === 'input' && reference >= 30001
                ? 30001
                : area === 'discrete' && reference >= 10001
                    ? 10001
                    : area === 'coil' && reference >= 1 && token === '0X'
                        ? 1
                        : null;
        addressNumber = standardBase === null ? reference - options.addressBase : reference - standardBase;
    } else if (/^\d+$/.test(compact)) {
        const reference = Number(compact);
        if (reference >= 40001 && reference <= 49999) {
            area = 'holding';
            addressNumber = reference - 40001;
        } else if (reference >= 30001 && reference <= 39999) {
            area = 'input';
            addressNumber = reference - 30001;
        } else if (reference >= 10001 && reference <= 19999) {
            area = 'discrete';
            addressNumber = reference - 10001;
        } else {
            area = 'coil';
            addressNumber = reference - options.addressBase;
        }
    } else {
        throw new Error('Modbus 地址格式不正确');
    }

    if (!Number.isInteger(addressNumber) || addressNumber < 0 || addressNumber > 65535) {
        throw new Error('Modbus 地址超出 0-65535 范围，请检查地址基准');
    }
    if (bit !== null && ['coil', 'discrete'].includes(area)) {
        throw new Error('线圈和离散输入本身就是位地址，不需要再填写 .位号');
    }

    const type = canonicalDataType(dataType);
    const registerCount = ['coil', 'discrete'].includes(area)
        ? 1
        : bit !== null || type === 'CHAR'
            ? 1
        : type === 'LREAL'
            ? 4
            : ['DINT', 'DWORD', 'REAL', 'DT', 'DTZ', 'DTL', 'DTLZ'].includes(type)
                ? 2
                : ['STRING', 'CHAR'].includes(type)
                    ? Math.max(1, Math.ceil(stringLength / 2))
                    : 1;
    if (addressNumber + registerCount > 65536) {
        throw new Error('Modbus 点位读取范围超出 0-65535 寄存器地址范围');
    }

    return { area, address: addressNumber, bit, type, registerCount, stringLength };
}

function isValidOpcUaNodeId(value) {
    const nodeId = String(value || '').trim();
    if (!nodeId || nodeId.length > 1024) return false;
    return /^(?:(?:ns=\d+|nsu=[^;]+);)?[isgb]=.+$/i.test(nodeId);
}

function normalizePointAddress(protocolValue, point, optionsValue = {}) {
    const protocol = normalizeProtocol(protocolValue);
    const raw = String(point?.plc_tag || '').trim();

    if (protocol === 'S7') {
        if (raw) return normalizeS7Address(raw, point?.data_type);
        const dbNumber = Number(point?.db_number);
        const byteOffset = Number(point?.db_byte_offset);
        if (!Number.isInteger(dbNumber) || !Number.isInteger(byteOffset)) return null;
        return composeS7DbAddress(dbNumber, byteOffset, Number(point?.bit_offset), point?.data_type);
    }

    if (!raw) return null;
    if (protocol === 'MODBUS_TCP') {
        parseModbusAddress(raw, point?.data_type, optionsValue);
        return raw.toUpperCase().replace(/\s+/g, '');
    }
    if (protocol === 'OPC_UA') return isValidOpcUaNodeId(raw) ? raw : null;
    return null;
}

function validatePointAddress(protocolValue, address, dataType, optionsValue = {}) {
    const protocol = normalizeProtocol(protocolValue);
    const raw = String(address || '').trim();
    if (!raw) return '必须填写 PLC 地址';

    if (protocol === 'MODBUS_TCP') {
        try {
            parseModbusAddress(raw, dataType, optionsValue);
            return '';
        } catch (error) {
            return error.message;
        }
    }
    if (protocol === 'OPC_UA') {
        return isValidOpcUaNodeId(raw)
            ? ''
            : 'OPC UA NodeId 格式不正确，例如 ns=2;s=Channel1.Device1.Tag1';
    }
    if (protocol === 'S7') {
        const compact = raw.replace(/\s+/g, '').toUpperCase();
        const valid = compact.includes(',')
            || /^(?:DB\d+\.(?:DBX|DBB|DBW|DBD)\d+(?:\.\d+)?|[IQM](?:X|B|W|D)?\d+(?:\.\d+)?)$/i.test(compact);
        return valid ? '' : 'S7 地址格式不正确，例如 DB1.DBW0 或 DB1.DBX0.0';
    }
    return `不支持的 PLC 协议：${protocol}`;
}

function buildOpcUaEndpoint(hostValue, portValue, optionsValue = {}) {
    const options = normalizePlcOptions('OPC_UA', optionsValue);
    const host = limitedString(hostValue, 512);
    if (!host) return '';
    if (/^opc\.tcp:\/\//i.test(host)) {
        if (!options.endpointPath || /\/[^/]+$/.test(host.replace(/^opc\.tcp:\/\/[^/]+/i, ''))) return host;
        return `${host.replace(/\/$/, '')}${options.endpointPath}`;
    }
    const port = boundedInteger(portValue, 1, 65535, 4840);
    return `opc.tcp://${host}:${port}${options.endpointPath || ''}`;
}

function formatEndpoint(plc) {
    const protocol = normalizeProtocol(plc?.protocol);
    const definition = getProtocolDefinition(protocol);
    const options = normalizePlcOptions(protocol, plc?.options);
    const host = String(plc?.ip || '').trim();
    const port = boundedInteger(plc?.port, 1, 65535, definition?.defaultPort || 102);
    if (protocol === 'S7') return `S7 ${host}:${port} (Rack=${plc?.rack ?? 0}, Slot=${plc?.slot ?? 1})`;
    if (protocol === 'MODBUS_TCP') return `Modbus TCP ${host}:${port} (Unit ID=${options.unitId})`;
    if (protocol === 'OPC_UA') return `OPC UA ${buildOpcUaEndpoint(host, port, options)}`;
    return `${protocol} ${host}:${port}`;
}

function endpointKey(plc) {
    const protocol = normalizeProtocol(plc?.protocol);
    const options = normalizePlcOptions(protocol, plc?.options);
    const safeOptions = { ...options };
    if (Object.prototype.hasOwnProperty.call(safeOptions, 'password')) {
        safeOptions.passwordHash = crypto.createHash('sha256').update(String(safeOptions.password || '')).digest('hex').slice(0, 16);
        delete safeOptions.password;
    }
    return `${protocol}:${plc?.ip || ''}:${plc?.port || ''}:${plc?.rack || 0}:${plc?.slot || 0}:${JSON.stringify(safeOptions)}`;
}

function publicProtocolDefinitions() {
    return Object.values(PROTOCOL_DEFINITIONS).map(definition => ({
        ...definition,
        defaultOptions: normalizePlcOptions(definition.value, {})
    }));
}

module.exports = {
    MASKED_SECRET,
    PROTOCOL_DEFINITIONS,
    normalizeProtocol,
    getProtocolDefinition,
    defaultPortForProtocol,
    normalizePlcOptions,
    sanitizePlcOptions,
    canonicalDataType,
    normalizeS7Address,
    composeS7DbAddress,
    parseModbusAddress,
    isValidOpcUaNodeId,
    normalizePointAddress,
    validatePointAddress,
    buildOpcUaEndpoint,
    formatEndpoint,
    endpointKey,
    publicProtocolDefinitions,
    safeObject
};
