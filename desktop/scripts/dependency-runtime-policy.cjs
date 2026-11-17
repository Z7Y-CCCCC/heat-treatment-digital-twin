'use strict';
const fs = require('node:fs');
const path = require('node:path');
const POLICY_VERSION = 'backend-dependencies-runtime-v2';
const normalize = name => name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
function entryTargets(value, output = []) {
    if (typeof value === 'string') output.push(value);
    else if (Array.isArray(value)) value.forEach(item => entryTargets(item, output));
    else if (value && typeof value === 'object') for (const [condition, item] of Object.entries(value)) {
        // TypeScript declarations are not a Node runtime condition.
        if (condition !== 'types' && !condition.startsWith('types@')) entryTargets(item, output);
    }
    return output;
}
function runtimeFile(name) {
    const base = path.posix.basename(normalize(name));
    // Notices remain in every archive, including LICENSE.md / COPYING.md.
    if (/^\.?(?:(?:third[ _-]?party|3rd[ _-]?party)[ _-]*)?(?:licen[cs]es?|copying|copyright|notices?)(?:[._ -]|$)/i.test(base)) return true;
    return !/\.(?:ts|tsx|mts|cts|map|md|markdown)$/i.test(base);
}
function dependencyRuntimePlan(source) {
    source = path.resolve(source);
    const files = [], directories = ['.'], manifests = [];
    function walk(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const filename = path.join(directory, item.name), relative = normalize(path.relative(source, filename));
            if (item.isDirectory()) { directories.push(relative); walk(filename); }
            else { files.push(relative); if (item.isFile() && item.name === 'package.json') manifests.push(relative); }
        }
    }
    walk(source);
    const protectedEntries = [];
    for (const name of manifests) {
        const manifest = JSON.parse(fs.readFileSync(path.join(source, name), 'utf8').replace(/^\uFEFF/, ''));
        const prefix = path.posix.dirname(name);
        for (const target of entryTargets([manifest.main, manifest.bin, manifest.exports, manifest.browser])) {
            const resolved = path.posix.normalize(path.posix.join(prefix, target));
            if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) continue;
            protectedEntries.push(new RegExp('^' + resolved.split('*').map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
        }
    }
    const retained = files.filter(name => runtimeFile(name) || protectedEntries.some(pattern => pattern.test(name)));
    const allowed = new Set(['.', ...retained]);
    for (const name of retained) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') { allowed.add(parent); parent = path.posix.dirname(parent); }
    }
    return { policy: POLICY_VERSION, sourceFiles: files.length, retainedFiles: retained.length,
        omittedFiles: files.length - retained.length, files: retained,
        filter: name => allowed.has(normalize(name) || '.') };
}
if (require.main === module) {
    const plan = dependencyRuntimePlan(path.resolve(process.argv[2] || path.join(__dirname, '../../backend/node_modules')));
    console.log(JSON.stringify({ policy: plan.policy, sourceFiles: plan.sourceFiles, retainedFiles: plan.retainedFiles, omittedFiles: plan.omittedFiles }, null, 2));
}
module.exports = { POLICY_VERSION, runtimeFile, dependencyRuntimePlan };
