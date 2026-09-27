const assert = require('node:assert/strict');
const { rasterExtension } = require('../routes/appearanceAssets');

assert.equal(rasterExtension(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0])), '.png');
assert.equal(rasterExtension(Buffer.from([0xff,0xd8,0xff,0,0,0,0,0,0,0,0,0,0,0,0,0])), '.jpg');
assert.equal(rasterExtension(Buffer.from('RIFF1234WEBP1234')), '.webp');
assert.equal(rasterExtension(Buffer.from('<svg><script>x</script></svg>')), '');
assert.equal(rasterExtension(Buffer.from('not an image')), '');
console.log('Appearance asset signatures: 5 checks passed.');
