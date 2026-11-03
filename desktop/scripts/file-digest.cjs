'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
// Model and runtime archives can exceed the JS heap budget. Hash incrementally.
function fileDigest(file) {
    const hash=crypto.createHash('sha256'), buffer=Buffer.allocUnsafe(256*1024), fd=fs.openSync(file,'r');
    let size=0, count;
    try { while ((count=fs.readSync(fd,buffer,0,buffer.length,null))>0) { hash.update(buffer.subarray(0,count)); size+=count; } }
    finally { fs.closeSync(fd); }
    return { size, sha256:hash.digest('hex') };
}
module.exports = { fileDigest };
