const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
require('../../backend/services/defaultDashboardTemplate').verifyDefaultDashboardTemplate();
const desktop = require(path.join(root, 'desktop/package.json'));
const manifest = require(path.join(root, 'release-manifest.json'));
if (!/^\d+\.\d+\.\d+$/.test(desktop.version)) throw new Error('Desktop version must be X.Y.Z');
if (manifest.productVersion !== desktop.version) throw new Error('desktop/package.json and release-manifest.json versions differ');
const { parseVersion, compareVersions } = require('./auto-release-version.cjs');
const releaseVersion = process.env.RELEASE_VERSION || desktop.version;
parseVersion(releaseVersion);
if (compareVersions(releaseVersion, desktop.version) < 0) throw new Error('Release version must not downgrade source');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== 'refs/tags/v' + releaseVersion) {
  throw new Error('Release tag must be v' + releaseVersion);
}
for (const filename of ['desktop/mysqlRuntime.cjs', 'desktop/directoryPublish.cjs', 'desktop/scripts/build-frontend.cjs', 'tools/packaged-mysql-smoke-test.cjs']) {
  if (!fs.existsSync(path.join(root, filename))) throw new Error(`Missing release source: ${filename}`);
}
console.log(`Release source version verified: ${desktop.version}`);
