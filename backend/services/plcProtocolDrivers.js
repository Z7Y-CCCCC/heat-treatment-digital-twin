const path = require('path');
const {
    canonicalDataType,
    normalizeProtocol,
    normalizePlcOptions,
    parseModbusAddress,
    buildOpcUaEndpoint
} = require('./plcProtocolConfig');

const opcUaCertificateManagers = new Map();

function opcUaCertificateManager(autoAcceptUnknown) {
    const mode = autoAcceptUnknown ? 'auto-trust' : 'strict';
    if (opcUaCertificateManagers.has(mode)) return opcUaCertificateManagers.get(mode);

    const { OPCUACertificateManager } = require('node-opcua-certificate-manager');
    const dataDirectory = process.env.APP_DATA_DIR
        ? path.resolve(process.env.APP_DATA_DIR)
        : path.resolve(__dirname, '..', 'data');
    const manager = new OPCUACertificateManager({
        rootFolder: path.join(dataDirectory, 'opcua-pki', mode),
        automaticallyAcceptUnknownCertificate: autoAcceptUnknown
    });
    opcUaCertificateManagers.set(mode, manager);
    return manager;
}

function normalizeScalar(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'bigint') {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) return Array.from(value);
    if (Array.isArray(value)) {
        if (value.length === 1) return normalizeScalar(value[0]);
        return value.map(normalizeScalar);
    }
    if (typeof value === 'object') {
        if (typeof value.toNumber === 'function') {
            const number = value.toNumber();
            if (Number.isFinite(number)) return number;
        }
        return JSON.stringify(value, (_, nested) => typeof nested === 'bigint' ? nested.toString() : nested);
    }
    return value;
}

function registerBuffer(registers, options) {
    const words = Array.from(registers || [], value => Number(value) & 0xffff);
    if (options.wordOrder === 'LE' && words.length > 1) words.reverse();
    const buffer = Buffer.alloc(words.length * 2);
    words.forEach((word, index) => {
        if (options.byteOrder === 'LE') buffer.writeUInt16LE(word, index * 2);
        else buffer.writeUInt16BE(word, index * 2);
    });
    return buffer;
}

function decodeModbusRegisters(registers, parsed, options) {
    const expected = Number(parsed.registerCount || 1);
    if (!registers || registers.length < expected) {
        throw new Error(`Modbus 返回寄存器数量不一致：期望 ${expected}，实际 ${registers?.length || 0}`);
    }
    if (Array.from(registers).some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
        throw new Error('Modbus 返回了无效寄存器值');
    }
    const type = canonicalDataType(parsed.type);
    const buffer = registerBuffer(registers, options);
    if (parsed.bit !== null) {
        return ((Number(registers?.[0] || 0) >>> parsed.bit) & 1) === 1;
    }
    if (type === 'BOOL') return Number(registers?.[0] || 0) !== 0;
    if (type === 'BYTE') return buffer.length ? buffer[buffer.length - 1] : 0;
    if (type === 'INT') return buffer.readInt16BE(0);
    if (type === 'WORD') return buffer.readUInt16BE(0);
    if (type === 'DINT') return buffer.readInt32BE(0);
    if (type === 'DWORD') return buffer.readUInt32BE(0);
    if (type === 'REAL') return buffer.readFloatBE(0);
    if (type === 'LREAL') return buffer.readDoubleBE(0);
    if (type === 'CHAR') return buffer.subarray(0, 1).toString('utf8').replace(/\0+$/g, '');
    if (type === 'STRING') return buffer.subarray(0, parsed.stringLength).toString('utf8').replace(/\0+$/g, '');
    if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(type)) {
        return buffer.toString('hex').toUpperCase();
    }
    return Number(registers?.[0] || 0);
}

class ModbusTcpDriver {
    constructor(endpoint, dependencies = {}) {
        this.endpoint = endpoint;
        this.options = normalizePlcOptions('MODBUS_TCP', endpoint.options);
        this.client = null;
        this.modbusModule = dependencies.modbusModule || null;
        this.readPlans = new WeakMap();
        this.badPoints = new Map();
    }

    async connect() {
        const ModbusRTU = this.modbusModule || require('modbus-serial');
        const client = new ModbusRTU();
        client.setID(this.options.unitId);
        client.setTimeout(this.endpoint.timeout);
        this.client = client;
        try {
            await client.connectTCP(this.endpoint.ip, {
                port: this.endpoint.port,
                timeout: this.endpoint.timeout
            });
            if (this.client !== client) throw new Error('Modbus TCP 连接已取消');
        } catch (error) {
            if (this.client === client) await this.disconnect();
            else {
                try { await client.close(); } catch (closeError) { try { client.destroy?.(); } catch (_) { /* ignore */ } }
            }
            throw error;
        }
    }

    async read(points) {
        if (!this.client) throw new Error('Modbus TCP 尚未连接');
        const values = {};
        let plan = this.readPlans.get(points);
        if (!plan) {
            plan = points.map(point => ({ point, parsed: parseModbusAddress(point.plc_address, point.data_type, this.options) }))
                .sort((a, b) => a.parsed.area.localeCompare(b.parsed.area) || a.parsed.address - b.parsed.address);
            this.readPlans.set(points, plan);
        }
        const groups = []; let probes = 0;
        for (const row of plan) {
            const { point, parsed: p } = row;
            if ((this.badPoints.get(point.tagName) || 0) > Date.now()) { values[point.tagName] = null; continue; }
            const last = groups[groups.length - 1], limit = ['coil', 'discrete'].includes(p.area) ? 2000 : 120;
            // Never bridge unconfigured holes: some PLCs reject those registers.
            if (last && last.area === p.area && p.address <= last.end && Math.max(last.end, p.address + p.registerCount) - last.start <= limit) {
                last.rows.push(row); last.end = Math.max(last.end, p.address + p.registerCount);
            } else groups.push({ area: p.area, start: p.address, end: p.address + p.registerCount, rows: [row] });
        }
        const readBlock = async rows => {
            const area = rows[0].parsed.area, start = Math.min(...rows.map(r => r.parsed.address)), end = Math.max(...rows.map(r => r.parsed.address + r.parsed.registerCount));
            const count = end - start, bits = ['coil', 'discrete'].includes(area);
            let response;
            try {
                const method = { coil: 'readCoils', discrete: 'readDiscreteInputs', input: 'readInputRegisters', holding: 'readHoldingRegisters' }[area] || 'readHoldingRegisters';
                const chunks = [], limit = bits ? 2000 : 120;
                for (let address = start; address < end; address += limit) {
                    const size = Math.min(limit, end - address), part = await this.client[method](address, size);
                    if (!part?.data || part.data.length < size) throw new Error(`Modbus 返回${bits ? '位' : '寄存器'}数量不一致：期望 ${size}，实际 ${part?.data?.length || 0}`);
                    chunks.push(...part.data.slice(0, size));
                }
                response = { data: chunks };
            } catch (error) {
                // A valid exception response is an address/function fault, not a
                // broken TCP session. Split the block, quarantine only bad points.
                // Transport/timeouts still fail this endpoint, never other endpoints.
                if (![1, 2, 3].includes(Number(error?.modbusCode))) throw error;
                if (rows.length > 1 && probes++ < 128) {
                    const middle = Math.floor(rows.length / 2); await readBlock(rows.slice(0, middle)); await readBlock(rows.slice(middle)); return;
                }
                for (const row of rows) { values[row.point.tagName] = null; this.badPoints.set(row.point.tagName, Date.now() + 10000); }
                return;
            }
            if (!response?.data || response.data.length < count) throw new Error(`Modbus 返回${bits ? '位' : '寄存器'}数量不一致：期望 ${count}，实际 ${response?.data?.length || 0}`);
            for (const { point, parsed } of rows) {
                const raw = response.data.slice(parsed.address - start, parsed.address - start + parsed.registerCount);
                if (bits && ![true, false, 0, 1].includes(raw[0])) throw new Error('Modbus 返回了无效位值');
                values[point.tagName] = bits ? Boolean(raw[0]) : decodeModbusRegisters(raw, parsed, this.options);
                this.badPoints.delete(point.tagName);
            }
        };
        for (const group of groups) await readBlock(group.rows);
        return values;
    }

    async disconnect() {
        const client = this.client;
        this.client = null;
        if (!client) return;
        try {
            await client.close();
        } catch (error) {
            try { client.destroy?.(); } catch (nestedError) { /* ignore */ }
        }
    }
}

function resolveOpcEnum(source, requested, fallback) {
    if (!source) return fallback;
    return source[requested] ?? source[String(requested || '').toUpperCase()] ?? fallback;
}

class OpcUaDriver {
    constructor(endpoint, dependencies = {}) {
        this.endpoint = endpoint;
        this.options = normalizePlcOptions('OPC_UA', endpoint.options);
        this.opcua = null;
        this.client = null;
        this.session = null;
        this.opcuaModule = dependencies.opcuaModule || null;
        this.certificateManagerFactory = dependencies.certificateManagerFactory || opcUaCertificateManager;
    }

    async connect() {
        const opcua = this.opcuaModule || require('node-opcua-client');
        this.opcua = opcua;
        const endpointUrl = buildOpcUaEndpoint(this.endpoint.ip, this.endpoint.port, this.options);
        if (!endpointUrl) throw new Error('OPC UA 服务器地址未配置');
        const securityMode = resolveOpcEnum(opcua.MessageSecurityMode, this.options.securityMode, opcua.MessageSecurityMode.None);
        const securityPolicy = resolveOpcEnum(opcua.SecurityPolicy, this.options.securityPolicy, opcua.SecurityPolicy.None);
        const clientOptions = {
            applicationName: 'HeatTreatmentDigitalTwin',
            endpointMustExist: false,
            securityMode,
            securityPolicy,
            connectionStrategy: {
                initialDelay: 0,
                maxDelay: this.endpoint.retryInterval,
                maxRetry: 0
            },
            connectionTimeout: this.endpoint.timeout,
            requestedSessionTimeout: Math.max(10000, this.endpoint.timeout * 4),
            keepSessionAlive: true
        };
        if (this.options.securityMode !== 'None') {
            clientOptions.clientCertificateManager = this.certificateManagerFactory(this.options.trustServerCertificate);
        }
        const client = opcua.OPCUAClient.create(clientOptions);
        this.client = client;
        try {
            await client.connect(endpointUrl);
            if (this.client !== client) throw new Error('OPC UA 连接已取消');

            const identity = this.options.username
                ? {
                    type: opcua.UserTokenType.UserName,
                    userName: this.options.username,
                    password: this.options.password
                }
                : { type: opcua.UserTokenType.Anonymous };
            const session = await client.createSession(identity);
            if (this.client !== client) {
                try { await session.close(); } catch (closeError) { /* ignore */ }
                throw new Error('OPC UA 会话建立已取消');
            }
            this.session = session;
        } catch (error) {
            if (this.client === client) await this.disconnect();
            else { try { await client.disconnect(); } catch (closeError) { /* ignore */ } }
            throw error;
        }
    }

    async read(points) {
        if (!this.session || !this.opcua) throw new Error('OPC UA 尚未建立会话');
        const nodesToRead = points.map(point => ({
            nodeId: point.plc_address,
            attributeId: this.opcua.AttributeIds.Value
        }));
        const response = await this.session.read(nodesToRead, 0);
        const dataValues = Array.isArray(response) ? response : [response];
        if (dataValues.length !== points.length) {
            throw new Error(`OPC UA 返回点位数量不一致：期望 ${points.length}，实际 ${dataValues.length}`);
        }

        const values = {};
        dataValues.forEach((dataValue, index) => {
            const statusCode = dataValue?.statusCode;
            const good = typeof statusCode?.isGood === 'function'
                ? statusCode.isGood()
                : Number(statusCode?.value ?? statusCode ?? 0) === 0;
            if (!good) {
                // A bad node must not discard good nodes in the same UA Read.
                values[points[index].tagName] = null;
                return;
            }
            values[points[index].tagName] = normalizeScalar(dataValue?.value?.value);
        });
        return values;
    }

    async disconnect() {
        const session = this.session;
        const client = this.client;
        this.session = null;
        this.client = null;
        try { await session?.close(); } catch (error) { /* ignore */ }
        try { await client?.disconnect(); } catch (error) { /* ignore */ }
    }
}

function createProtocolDriver(endpoint, dependencies = {}) {
    const protocol = normalizeProtocol(endpoint?.protocol);
    if (protocol === 'MODBUS_TCP') return new ModbusTcpDriver(endpoint, dependencies);
    if (protocol === 'OPC_UA') return new OpcUaDriver(endpoint, dependencies);
    throw new Error(`没有可用的 ${protocol} 协议驱动`);
}

module.exports = {
    createProtocolDriver,
    ModbusTcpDriver,
    OpcUaDriver,
    decodeModbusRegisters,
    normalizeScalar
};
