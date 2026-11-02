const { isValidUsername, normalizeUsername } = require('../../shared/accountPolicy.mjs');

const MAX_RECENT_USERNAMES = 8;
function recentUsernames(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter(value => typeof value === 'string').map(normalizeUsername).filter(isValidUsername))]
        .slice(0, MAX_RECENT_USERNAMES);
}

function decodeLoginHistory(value) {
    if (typeof value !== 'string' || value.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(value)) return [];
    try { return recentUsernames(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
    catch { return []; }
}

function encodeLoginHistory(values) {
    // Username hints only. This cookie never contains a password, session token,
    // authorization flag or CSRF value, and is never trusted for authentication.
    return Buffer.from(JSON.stringify(recentUsernames(values)), 'utf8').toString('base64url');
}

module.exports = { recentUsernames, decodeLoginHistory, encodeLoginHistory };
