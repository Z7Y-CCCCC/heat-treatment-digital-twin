'use strict';
// Node >=22.12 supports synchronous require of ESM without top-level await.
// One implementation serves the backend and Vite's browser development server.
module.exports = require('./inspectionConfig.mjs').default;
