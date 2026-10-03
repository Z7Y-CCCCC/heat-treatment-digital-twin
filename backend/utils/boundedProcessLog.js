const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');

// A pipe stays open while the child runs, allowing rotation without restarting
// MySQL. At most the active file and one previous file belong to this writer.
class BoundedProcessLog extends Writable {
    constructor(filename, maxBytes = 10 * 1024 * 1024) {
        super();
        this.filename = filename;
        this.maxBytes = maxBytes;
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.fd = fs.openSync(filename, 'a');
        this.bytes = fs.fstatSync(this.fd).size;
    }
    _write(chunk, encoding, done) {
        try {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            // Split oversized chunks too, rather than allowing one large write
            // to bypass the cap. Only this writer's .previous file is replaced.
            for (let offset = 0; offset < data.length;) {
                if (this.bytes >= this.maxBytes) {
                    fs.closeSync(this.fd); this.fd = null;
                    fs.rmSync(`${this.filename}.previous`, { force: true });
                    fs.renameSync(this.filename, `${this.filename}.previous`);
                    this.fd = fs.openSync(this.filename, 'a'); this.bytes = 0;
                }
                const length = Math.min(data.length - offset, this.maxBytes - this.bytes);
                fs.writeSync(this.fd, data, offset, length);
                this.bytes += length; offset += length;
            }
            done();
        } catch (error) { done(error); }
    }
    _final(done) { this.close(); done(); }
    _destroy(error, done) { this.close(); done(error); }
    close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
}
module.exports = { BoundedProcessLog };
