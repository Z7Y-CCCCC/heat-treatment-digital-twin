// Adapter around nodes7 0.3.x. Its packetizer limits bytes but not the S7
// ReadVar item count, and its socket callback assumes complete TCP packets.
// Keep native decoding/optimization while bounding requests and framing TCP.
function protectS7Reads(connection, onFailure) {
    const prepare = connection.prepareReadPacket;
    if (typeof prepare === 'function') connection.prepareReadPacket = function(...args) {
        const result = prepare.apply(this, args);
        this.readPacketArray = this.readPacketArray.flatMap(packet => {
            const packets = [];
            for (let start = 0; start < packet.itemList.length; start += 20) {
                packets.push({ ...packet, itemList: packet.itemList.slice(start, start + 20),
                    seqNum: start === 0 ? packet.seqNum : this.getNextSeqNum() });
            }
            return packets;
        });
        return result;
    };
    const readResponse = connection.readResponse;
    if (typeof readResponse === 'function') connection.readResponse = function(data, sequence) {
        const packet = this.readPacketArray[sequence];
        if (data && (!packet || data.length < 21 || data[20] !== packet.itemList.length)) {
            throw new Error('S7 响应点位数量与请求不一致');
        }
        return readResponse.call(this, data, sequence);
    };
    let pending = Buffer.alloc(0);
    const onResponse = connection.onResponse;
    if (typeof onResponse === 'function') connection.onResponse = function(chunk) {
        try {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            if (pending.length > 1024 * 1024) throw new Error('S7 TCP 响应缓冲超过限制');
            while (pending.length >= 4) {
                if (pending[0] !== 3 || pending[1] !== 0) throw new Error('S7 TPKT 响应头无效');
                const length = pending.readUInt16BE(2);
                if (length < 7) throw new Error('S7 TPKT 响应长度无效');
                if (pending.length < length) break;
                const packet = pending.subarray(0, length);
                pending = pending.subarray(length);
                onResponse.call(this, packet);
            }
        } catch (error) {
            pending = Buffer.alloc(0);
            onFailure(error);
        }
    };
    // Timeouts invoke readResponse without going through the socket callback.
    const packetTimeout = connection.packetTimeout;
    if (typeof packetTimeout === 'function') connection.packetTimeout = function(...args) {
        try { return packetTimeout.apply(this, args); }
        catch (error) { onFailure(error); }
    };
}

module.exports = { protectS7Reads };
