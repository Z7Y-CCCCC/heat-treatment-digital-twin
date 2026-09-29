const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const desktop = require(path.join(root, 'desktop/package.json'));
const manifest = require(path.join(root, 'release-manifest.json'));
if (!/^\d+\.\d+\.\d+$/.test(desktop.version)) throw new Error('Desktop version must be X.Y.Z');
if (manifest.productVersion !== desktop.version) throw new Error('desktop/package.json and release-manifest.json versions differ');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/v${desktop.version}`) {
  throw new Error(`Release tag must be v${desktop.version}`);
}
for (const filename of ['desktop/mysqlRuntime.cjs', 'desktop/directoryPublish.cjs', 'desktop/scripts/build-frontend.cjs', 'tools/packaged-mysql-smoke-test.cjs']) {
  if (!fs.existsSync(path.join(root, filename))) throw new Error(`Missing release source: ${filename}`);
}
console.log(`Release source version verified: ${desktop.version}`);
